# 团队共享 Provider（中转站）下发

让同事零配置使用一把团队共享的中转站 key：管理员在控制台手动给某个用户开/关，
被授权的用户下次启动 Neo 自动在模型选择器里看到共享模型，无需自己配 key。

## 架构（一条链）

```
管理员控制台 /entitlements  ──写──▶  Supabase control_plane_entitlements (capabilities += shared_relay)
                                                  │
用户 Neo 启动 → 拉 cloud_config（带 Supabase JWT）│
                                                  ▼
Vercel 控制面网关 applyServerEntitlementGate ── 按 subject 的 entitlement 过滤 sharedProviders ──▶
  · 命中 shared_relay → 下发该 provider（含中转站 key，签名信封，仅此 subject）
  · 未命中 → 整条剥离，key 绝不下发
                                                  ▼
客户端 cloudConfigService → configService.reconcileManagedProviders()
  → 注入成 managedByCloud 的 custom-team-relay provider（key 进 SecureStorage，不落明文）
  → 模型选择器自动出现「团队共享」来源的模型；任务通过中转站流式跑
```

## 关键文件

| 层 | 文件 |
|---|---|
| 服务端类型 | `vercel-api/lib/controlPlanePayloads.ts`（`SharedProviderConfig` + `CloudConfigPayload.sharedProviders`）|
| 服务端网关 | `vercel-api/lib/controlPlaneEntitlements.ts`（`filterSharedProviders` 按 entitlement 剥离 key）|
| 客户端类型 | `src/main/services/cloud/builtinConfig.ts`（`SharedProviderConfig` + `CloudConfig.sharedProviders`）|
| 客户端 reconcile | `src/main/services/core/configService.ts`（`reconcileManagedProviders`）|
| 拉取后回调 | `src/main/services/cloud/cloudConfigService.ts`（`onSharedProvidersResolved`）|
| 接线（双路径）| `src/main/app/initBackgroundServices.ts`（Electron）+ `src/web/webServer.ts`（发行版 Tauri）|
| 管理台开关 | `admin-console/app/entitlements/`（page + actions）|
| 授权存储 | `supabase` 表 `control_plane_entitlements`（已存在，无需新迁移）|

## 生产激活步骤（需要 Vercel + Supabase 权限）

### 1. Vercel 控制面项目（`code-agent`，rootDir=`vercel-api`）设置 env

启用按用户鉴权下发（让网关能解析 subject 并查 entitlement）：

```
CONTROL_PLANE_SUPABASE_URL              = <Supabase project URL>
CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY = <service role key>   # 仅用于服务端校验 JWT + 查 entitlement
```

在 `CONTROL_PLANE_CLOUD_CONFIG_JSON` 里加入 `sharedProviders`（**key 放这里，永远不进客户端构建包**）：

**推荐：混合方案（key 留 env、配置进 DB，改配置零部署）。**

为什么混合：anon key 本就是公开的（打进客户端/每个请求头都带），所以一旦把 key 放进 DB，RLS 就是唯一的墙，配错即漏。把 key 留在 Vercel env（对客户端零可达面），只把「会变的配置」放 DB，既拿到"改模型/开关不用重新部署 Vercel"的好处，又让 key 永不进库。

**Vercel env（一次性，含机密）：**
```
CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB   = 1                 # 打开 DB 取配置（不开则走 env-JSON 兜底）
CONTROL_PLANE_SUPABASE_URL               = <Supabase URL>
CONTROL_PLANE_SUPABASE_SERVICE_ROLE_KEY  = <service role key>  # 服务端读表/校验 JWT，绕过 RLS
SHARED_RELAY_API_KEY                      = <中转站 token，机密>  # key 只在这里；表里只存这个变量名
```

**Supabase（DB，零部署改）：** 应用迁移 `supabase/migrations/20260605000000_shared_providers.sql`（建 `control_plane_shared_providers` 表 + admin-only RLS）。然后在管理台 **共享Provider** 页加一条：
- id `custom-team-relay`、展示名「团队共享」、端点 `https://tokenflux.dev/v1`
- **key 所在 env 变量名** = `SHARED_RELAY_API_KEY`（不是 key 本身）
- 模型白名单**自己挑能用的**：实测 `gpt-5.5` / `gpt-5.4-mini` 通，`gpt-5.3` 上游 502，别放
- 授权门 capability = `shared_relay`（仅授权用户）；留空 = 所有登录用户

以后改模型/换端点/开关 = 管理台点一下，**零 Vercel 部署**。换 key = 改那个 env 变量（少见，需一次重部署）。

**RLS 验证（强烈建议，把"会不会写松"变确定性）：** 应用迁移后跑 anon-probe，证明公开 anon key 读不到这两张表：
```
HTTPS_PROXY=http://127.0.0.1:7897 SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_ANON_KEY=<anon> node scripts/verify-shared-providers-rls.mjs
# 期望全部 ✓：anon 被拒或 0 行
```

**兜底（不想动 DB 时）：** 不设 `CONTROL_PLANE_SHARED_PROVIDERS_FROM_DB`，直接在 `CONTROL_PLANE_CLOUD_CONFIG_JSON` 里塞 `sharedProviders`（含 `apiKey`）即可——但这样 key 进了 env-JSON、改配置要重部署，且失去 DB 管理。仅建议临时验证用。

部署：push 触发或 `vercel --prod`。⚠️ 控制面部署历史上卡在 Hobby plan 账单（见 `code_agent_distribution_architecture` memory），发版前确认 Vercel 构建未被 block。**注意：只有"加 DB 读取逻辑"这一次需要重新部署；之后改配置全走 DB。**

### 2. 客户端发版

本功能代码需随客户端发版生效（`git tag vX.Y.Z && git push --tags` 走 CI）。
发行版跑的是 `webServer.ts` 路径，已接线，无需额外操作。

### 3. 给同事授权

管理台 → **授权** 页 → 填同事 user_id（从 Users 页复制）→「授予共享 Key」。
同事下次启动 Neo 自动出现「团队共享」模型。

## 关闭

- **关单人**：授权页点「撤销」→ 下次拉取自动从其本地移除（含删 SecureStorage 里的 key）。
- **一键全员关**：中转站后台吊销/轮换那把 token → 所有人立即失效，不依赖发版。

## 安全边界

- key 只在「已登录且被授权」的 subject 的签名信封里下发；未授权用户在网关层就被剥离，response 里无 key（单测 `tests/unit/vercel/sharedProviders.test.ts` 锁死）。
- key 在客户端只进 SecureStorage（OS 加密），不落明文 settings/config.json（单测 `configService.sharedProviders.test.ts` 锁死）。
- 残余风险：被授权用户理论上可从自己机器的 SecureStorage 提取 key 在 Neo 外使用。缓解=中转站设消费上限 + 只配便宜模型分组 + 随时轮换。对内部同事可接受。

## 已验证（本地）

- 网关按 entitlement 剥离 key：5/5 单测。
- 客户端 reconcile 增删 + key 不落明文 + 不误删用户自建 provider：3/3 单测。
- 模型选择器展示：2/2 单测（展示为 `providerLabel: 团队共享`，因模型名 `gpt-5.x` 归在 OpenAI 组下）。
- 中转站真实链路：`/v1/models` + 非流式 + **流式** chat completion 全通（gpt-5.5 / gpt-5.4-mini）。
- 全量 typecheck 通过；61 条相关回归测试通过。

## 已知小限制

模型名是 `gpt-5.x` 时，选择器把它们归到 OpenAI 组（来源标「团队共享」）。
若用户同时配了自己的真 OpenAI key，同组去重可能让二者互相遮蔽。
对「没有自己 key 的同事」无影响。需要时可后续强制共享 provider 独立成组。

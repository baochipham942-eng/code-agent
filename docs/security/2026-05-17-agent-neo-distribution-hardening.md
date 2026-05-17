# Agent Neo 分发安全加固方案

> 日期: 2026-05-17
> 范围: macOS DMG / Tauri app bundle / 本地 web server / 云端配置与服务端边界

## 结论

Agent Neo 要分发给外部用户，安全重点要从“让 DMG 无法被反编译”切到“DMG 里只放允许被看见的东西”。macOS app bundle、Tauri resource、renderer JS、Node server bundle 和 node_modules 都能被用户复制出来分析。混淆、压缩、签名只能提高逆向成本，不能保护已经下发到客户端的产品策略、系统 prompt、架构文档、服务端密钥或商业规则。

P0 必须先做三件事：

1. release 包不带第一方 sourcemap、源码树、测试、docs、`.env`、`.dev-token`、私钥和内部架构文档。
2. 把高价值产品逻辑放到服务端，包括 license/entitlement、远程能力市场、实验/feature flag、付费策略、管理权限、敏感 prompt 分发。
3. 每次 DMG 出包后跑 bundle inventory scan，把“泄露检查”变成 release gate。

## 当前风险

本次检查到的直接问题：

| 风险 | 证据 | 影响 |
| --- | --- | --- |
| renderer sourcemap 出现在 `dist/renderer` 和已安装 app bundle | `/Applications/Code Agent.app/Contents/Resources/_up_/dist/renderer/assets/*.js.map` | 可直接还原组件名、源码路径和前端结构 |
| web server sourcemap 被显式写进 Tauri resources | `src-tauri/tauri.conf.json` 曾包含 `../dist/web/webServer.cjs.map` | 本地主进程/服务端适配层实现会被还原 |
| Node server bundle 是 JS | `dist/web/webServer.cjs` 被打进 bundle | 关键业务如果留在本地，只能延缓阅读，不能保密 |
| app bundle 带第三方包源码和 map | `node_modules/*/src`、`node_modules/*/*.map` | 主要是体积和噪音风险，第一方泄露风险较低 |
| 本地文档含完整产品和架构信息 | `docs/ARCHITECTURE.md`、`docs/architecture/*` | 如果 docs 进入 DMG，会直接暴露产品路线和架构 |

## 客户端分发边界

DMG 中允许存在：

- 已压缩的 renderer 静态资源。
- 已压缩的本地 web server bundle。
- 必需 native 模块和最小 runtime 资源。
- 公共产品文案、图标、协议、版本信息。

DMG 中禁止存在：

- 第一方 `.map` 文件和 `sourceMappingURL` 注释。
- `src/`、`tests/`、`docs/`、`memory/`、`scripts` 里的内部分析材料。
- `.env`、`.env.local`、`.dev-token`、`.npmrc`、私钥、证书、service role key。
- 内部 prompt 全量语料、架构研究资产、roadmap、竞品分析、未发布能力说明。
- 任何能直接访问管理 API 的长效 token。

## 服务端边界

外部分发后，服务端要承接这些“不能下发”的能力：

| 能力 | 客户端只保留 | 服务端负责 |
| --- | --- | --- |
| License / entitlement | 登录态、设备指纹、短期 token | 用户权限、席位、过期时间、撤销、风控 |
| Feature flag / rollout | flag 拉取和本地缓存 | 分人群、分版本、灰度、kill switch |
| Capability marketplace | 本地 disabled draft、权限展示 | registry、签名、hash、评分、审核、下架 |
| Prompt / policy | 基础安全壳和公共提示 | 高价值策略、动态路由、实验 prompt |
| Admin | 前端入口显示 | admin RPC、RLS、审计日志、服务端权限判断 |
| Update | Tauri updater client | 签名 manifest、版本策略、强制升级、撤回 |
| Billing / quota | 用量展示 | 计费、额度、限流、异常检测 |

客户端可以缓存结果，但不能把决策权长期放在本地。用户能 patch 本地 JS，所以任何“只靠前端隐藏”的限制都只能算体验层。

## P0 Release Gate

这轮已加入第一刀 release gate：

- 生产 Vite renderer 关闭 sourcemap。
- 生产 esbuild web server 关闭 sourcemap 并启用 minify。
- Tauri resources 移除 `dist/web/webServer.cjs.map`。
- 新增 `npm run release:security-scan`，扫描第一方 sourcemap、源码、docs/tests/src、`.env`、私钥和 sourceMappingURL。
- `tauri:bundle`、`tauri:release:bundle`、`tauri-install.sh` 接入 release scan；最终 app bundle 可用 `npm run release:verify-macos` 复查。
- `tauri:release:bundle` 在 `REQUIRE_NOTARIZATION=1` 时要求 Apple notarization 凭据，并串起 DMG notarization、staple、Developer ID/TeamIdentifier/Gatekeeper 验证。

验收标准：

```bash
npm run build
npm run release:security-scan
npm run release:verify-macos
find dist -type f -name '*.map'
```

期望结果：第一方 `dist/renderer`、`dist/web`、`dist/cli` 不再出现 `.map`，scan 通过。第三方 node_modules 里可能仍有 map 或 README，这类先作为 warning，不阻断 P0。

## P1 服务端化

P1 不建议继续在客户端里堆“防反编译技巧”，应把敏感逻辑拆出去：

1. 建一个最小 Agent Neo control plane：auth、entitlement、release channel、remote config、capability registry。
2. 客户端启动时只拿短期 token 和签名配置；本地缓存必须有 TTL 和版本号。
3. capability registry 返回 signed metadata，客户端验证 signature/hash 后只生成 disabled draft。
4. prompt registry 按权限下发策略片段，客户端只留公共 fallback。
5. 管理面只通过 Supabase RPC 或自有 API 读写，service role 永不进客户端。
6. update manifest 用 Tauri updater 签名，发布流水线强制验签和 notarization。

本轮已先把本地 Capability Center 的 P1-B 信任闸门补上：含 `mcp_template.install.mcpServer` 的 registry 文件必须有匹配的 `source.contentHash` 和未来 `source.expiresAt`，否则卡片只保留安装预览，`actions.canInstallDraft=false`，service 侧 `installDraft` 会在写 `.code-agent/mcp.json` 前拒绝。`signature/keyId/signedAt` 已进入 contract/schema，远程 control plane 接入后再把签名验真接上。

P1-C 继续把远程配置入口改成 control-plane envelope：`CloudConfigService` 只接受 `schemaVersion:1`、`kind:"cloud_config"`、payload hash 匹配、未过期且 Ed25519 签名通过的配置；未签名、过期、hash mismatch 或未知 key 的响应全部回退内置配置。请求会附带当前 Supabase access token，服务端可以按用户和设备做 entitlement、release channel、feature flag 与 MCP registry 下发。

P1-D 同步收紧 prompt registry：`PromptService` 只接受 `kind:"prompt_registry"` 的签名 envelope，远程 prompt 未签名或过期时继续使用本地 builder 的公共 prompt。当前主链 `getSystemPrompt()` 仍固定返回本地 prompt，但这个入口先 fail closed，避免后续接线时把未验证 prompt 带进运行时。

P1-E 补上最小 Vercel control-plane 产物：`vercel-api/api/v1/config.ts` 返回 `kind:"cloud_config"` envelope，`vercel-api/api/prompts.ts` 返回 `kind:"prompt_registry"` envelope，二者共用 Ed25519 签名、payload canonical hash、`expiresAt`、ETag 和 `503 control_plane_unconfigured` fail-closed 行为。服务端私钥来自 `CONTROL_PLANE_PRIVATE_KEY`，客户端只配置 `CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY(S)`。

P1-F 把客户端公钥供给接进 release 链：`build:web` 生成 `dist/web/control-plane-public-keys.json`，Tauri resources 打包该文件，运行时 env 缺失时从 bundled file 读取公钥。`tauri:release:bundle` 默认要求配置 control-plane 公钥，`verify-macos-release` 在 notarization gate 下会验证 app bundle 内公钥文件存在且非空。

P1-G 收紧旧 cloud update direct-download：`UpdateService.downloadUpdate()` 默认要求缓存的云端 update metadata 带合法 64 位 hex `sha256`，缺失或格式错误会拒绝下载。只有显式设置 `CODE_AGENT_ALLOW_UNSIGNED_UPDATE_DOWNLOAD=1` 才走兼容模式；常规 release 应优先走 Tauri updater 的签名 manifest。

P1-H 补上 Vercel `/api/update` 实现：`GET action=health|check` 从 GitHub Releases 派生更新 metadata，手工下载 URL 只返回 release page，不返回二进制直链；`POST /api/update/publish` 只做 `CI_PUBLISH_TOKEN` 校验和兼容响应。release workflow 对 Cloud API publish 改用 `curl --fail-with-body`，避免配置了 Cloud API 但服务端失败时静默绿灯。

P1-I 把最小 control-plane policy 纳入签名 cloud config：payload 可携带 `entitlement`、`killSwitches`、`release`。客户端保留内置本地默认，但远端签名配置一旦下发，`FeatureFlagService` 会按 entitlement 和 kill switch 对高风险 boolean flag fail closed；release channel/minVersion 作为 signed policy 暴露给主进程读取，后续 update/channel 逻辑可继续收口到同一份 policy。

P1-J 收紧 marketplace plugin 安装默认态：`installPlugin()` 仍会复制 marketplace skill/command 文件，但安装记录默认 `isEnabled:false`，`getEnabledSkillDirs()` 不会把新装插件加入 skill discovery；只有显式 `enablePlugin()` 后才 reload 并进入可调用路径。

P1-K 把 signed release policy 接入 JS update path：`UpdateService.checkForUpdates()` 会把 signed `release.channel` 传给 Vercel update query，并在 Vercel、GitHub fallback、双失败三条路径上统一应用 `minVersion/latestVersion/forceUpdate/downloadUrl/sha256`。`minVersion` 高于当前版本时即使 update API 不可用也会返回强制更新；`sha256` 会归一化后进入 direct-download gate。

P1-L 把同一组 release policy 字段补到 Vercel update metadata 和 Tauri cloud fallback：`/api/update?action=check` 支持 `channel` query，并可从 `UPDATE_MIN_VERSION[_CHANNEL]`、`UPDATE_LATEST_VERSION[_CHANNEL]`、`UPDATE_FORCE_UPDATE[_CHANNEL]`、`UPDATE_DOWNLOAD_URL[_CHANNEL]`、`UPDATE_SHA256[_CHANNEL]` 输出策略字段。Tauri native updater 仍优先走签名 updater manifest；只有 native updater 无更新或失败时才读 cloud fallback，并按 `minVersion` 推导 `hasUpdate/forceUpdate/latestVersion`，手动更新 URL 仍只允许 HTTPS release page 或可转换成 GitHub release page 的 asset URL。

P1-M 收紧远程 skill 仓库启动面：推荐仓库不再默认随启动预下载，除非显式设置 `CODE_AGENT_ALLOW_RECOMMENDED_SKILL_AUTO_DOWNLOAD=1`；远程仓库中的 skills 也不再默认启用。内置 skills 仍可默认挂载，第三方/推荐 repo 需要用户主动下载并启用后才进入默认挂载和调用路径。

P1-N 补上 capability registry 的 control-plane artifact：Vercel `/api/v1/control-plane?artifact=capabilities` 和 `/api/v1/capabilities` 会返回 `kind:"capability_registry"` 的签名 envelope，payload 来自 `CONTROL_PLANE_CAPABILITY_REGISTRY_JSON` 或兼容的 `CODE_AGENT_CONTROL_PLANE_CAPABILITY_REGISTRY_JSON`。这先补服务端出口，客户端 Capability Center 后续再切到验签消费。

P1-O 把 cloud MCP server 接入同一套 signed control-plane policy：`mcpServers` 仍可随签名 cloud config 下发，但客户端只有在 global kill switch 未开启、相关 feature kill switch 未禁用、entitlement 处于可用状态且包含 `mcp_cloud`/`mcp_server` 或 `*` 时才会把 cloud scope MCP 写入 MCP client。policy revoke 或 kill switch 生效时，启动和刷新路径都不会 add/connect cloud MCP；已存在的 cloud scope server 会在刷新时移除，本地 user/project/local/runtime MCP 配置不受影响，也不会被 cloud refresh 覆盖。

P1-P 把 signed prompt registry 接入 Prompt 主链，但只作为低风险追加片段：客户端只消费 `policyAddon` 和 `publicSystemAddon` 两个命名 fragment，并由本地 builder 包进 `<signed_remote_prompt_fragments>`。`gen8`、`SYSTEM_PROMPT`、`systemPrompt` 等完整替换键不会进入运行时 prompt。验签失败、过期、缺少公钥或未签名时远程片段清空，主链继续返回本地公共 `SYSTEM_PROMPT` fallback。

P1-Q 把 Capability Center 切到消费 signed capability registry：客户端只在本地配置了 control-plane 公钥时拉取 `/api/v1/capabilities`，并用同一套 `controlPlaneTrust` 校验 `kind:"capability_registry"`、payload hash、`expiresAt` 和 Ed25519 签名。未签名、过期、hash mismatch、坏签名或未知 key 的远程 registry 全部 fail closed，Capability Center 只保留本地 curated fallback。可信远程 registry 进入库存页后仍只生成 disabled MCP draft，不启用、不启动命令、不连接远程服务。

## P1 Production Closing

P1 已在 Vercel production 验收到最小闭环：

- 代码已推到 `main`，当前 closing HEAD 是 `1fd57f67 fix(vercel): resolve control plane esm imports`。
- Vercel production 已写入 control-plane env：`CONTROL_PLANE_PRIVATE_KEY`、`CONTROL_PLANE_KEY_ID`、`CONTROL_PLANE_TTL_SECONDS`、`CONTROL_PLANE_CLOUD_CONFIG_JSON`、`CONTROL_PLANE_PROMPT_REGISTRY_JSON`、`CONTROL_PLANE_CAPABILITY_REGISTRY_JSON`、`CODE_AGENT_CONTROL_PLANE_KEY_ID`、`CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY`、`CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS`。
- 当前 production deployment 是 `dpl_3siddi5sAjia68yGi8tAigZBzUoN`，`code-agent-beta.vercel.app` 已 alias 到该 deployment。
- 线上 smoke 已通过：`/api/v1/config`、`/api/prompts?gen=all`、`/api/v1/control-plane?artifact=capabilities` 均返回 HTTP 200 signed envelope，`keyId=production-2026-05-17`。
- P1 closing 时生产默认 payload 是锁定态：`entitlement.status=revoked`，`prompts={}`，`capability_registry.items=[]`，`mcpServers=[]`。这表示分发通道、签名、TTL、hash 和 fail-closed 路径已跑通，但还没有发布可运营能力。
- 线上首次部署暴露过一个 Vercel ESM 运行时问题：TypeScript 函数编译成 `.js` 后不解析 extensionless import。已把 `vercel-api` 内部相对导入改成 `.js`，并把 `vercel-api/tsconfig.json` 切到 `module/moduleResolution: NodeNext`，避免同类问题只在线上暴露。

P1 closing 验证命令：

```bash
npx tsc -p vercel-api/tsconfig.json --noEmit
npx vitest run tests/unit/vercel/controlPlaneArtifacts.test.ts tests/unit/vercel/controlPlaneEnvelope.test.ts tests/unit/vercel/updateMetadata.test.ts tests/scripts/controlPlaneSmoke.test.ts tests/scripts/generateControlPlaneEnv.test.ts
node scripts/control-plane-smoke.mjs https://code-agent-beta.vercel.app
vercel inspect code-agent-beta.vercel.app
vercel env ls
```

P2 可以从这里往前走。P2 不需要再证明“签名 envelope 能不能上线”，而是要把空 payload 变成可运营的远程发布流程：registry 内容生产、签名发布、灰度、撤回、审计和后台管理。

## P2 可运营远程能力分发与发布治理

P2 的主线是把 production 里当前锁定的空 payload 变成可发布、可灰度、可撤回、可审计的远程供给。P1 已经证明 signed envelope、Vercel production env、TTL、hash、fail-closed 和客户端验签消费能跑通；P2 要补的是内容生产、发布治理和回滚链路。

P2 发布对象先限定为：

| Artifact | 发布内容 | 默认客户端结果 | 关键约束 |
| --- | --- | --- | --- |
| Capability registry | MCP template、channel adapter template、workflow recipe | 库存页可见，最多生成 disabled draft | 远程条目必须验签、未过期、hash 匹配；`revokedIds` 要能下架 |
| Prompt registry | `policyAddon`、`publicSystemAddon` | 作为低风险追加片段进入本地 prompt builder | 不允许替换完整 `SYSTEM_PROMPT`、`gen8` 或任意运行时 prompt |
| Cloud config | entitlement、kill switches、release policy、cloud MCP policy | 改变 feature/MCP/update 策略 | entitlement revoke 和 kill switch 必须 fail closed |
| Release policy | channel、minVersion、latestVersion、forceUpdate、downloadUrl、sha256 | 影响 update check 和 fallback | 二进制下载仍必须有 hash；手工链接优先 release page |
| Cloud MCP policy | `mcpServers` 加 policy gate | 只在有 entitlement 时接入 cloud scope MCP | policy revoke 时移除 cloud scope server，不碰本地 MCP |

### 内容生产与审核

每次发布都要生成一个本地 release bundle，bundle 只产出可审计文件，不直接写 Vercel、不部署、不碰 production 私钥：

- `cloud-config.json`
- `prompt-registry.json`
- `capability-registry.json`
- `manifest.json`
- `vercel-env-commands.txt`
- 可选 `rollback-env-commands.txt`

`manifest.json` 至少记录 `schemaVersion`、`version`、`channel`、`keyId`、`createdAt`、三类 artifact 的 `sha256`、上一版本、是否可回滚。这样 review 时看 manifest 和 payload 就能知道这次准备发布什么，发布命令只负责把已审过的 payload 写进 control-plane env。

### 发布通道

P2 支持 `stable`、`beta`、`canary` 三类 channel。channel 不是 UI 文案，而是发布决策边界：

- `stable` 只接受 reviewed 内容，默认不给高风险能力打开 entitlement。
- `beta` 可发布新模板或 prompt addon，但仍然只到 disabled draft。
- `canary` 可验证 registry 结构和 kill switch 行为，必须可一键回滚到上一 bundle。

每个 channel 的 payload 都要能绑定 `entitlement`、`killSwitches`、`release.channel` 和 capability registry version。灰度靠服务端 entitlement 和 signed release policy，不靠客户端隐藏入口。

### 客户端消费规则

客户端规则延续 P1-Q：

- 只消费 signed control-plane envelope。
- 未签名、过期、hash mismatch、坏签名、未知 key 全部 fail closed。
- 可信远程 capability registry 也只进入库存页，默认不启用、不连接、不执行。
- MCP template 继续只生成 `enabled:false`、`lazyLoad:true` 的 disabled draft。
- registry 里的 secret、env value、headers 不进入安装路径。
- 远程 prompt 只允许 `policyAddon` 和 `publicSystemAddon`。

### 安装、启用、连接、调用

P2 必须保持四段式边界：

| 阶段 | 含义 | 默认允许 |
| --- | --- | --- |
| 安装 | 写入本地草稿或配置预览 | 仅 disabled draft |
| 启用 | 加入运行时发现和可用列表 | 需要用户显式操作 |
| 连接 | 启动进程、连外部账号或触达网络 | 需要权限和配置齐备 |
| 调用 | 模型或用户实际触发能力 | 受工具权限、MCP 状态和 runtime policy 约束 |

远程市场的第一版只做到“可发现、可审计、可导入为草稿”。任何会启动命令、连接账号、读取文件或写配置的动作，都必须留在用户确认之后。

### 撤回、下架与 Kill Switch

P2 需要补齐四类撤回语义：

- `capability_registry.revokedIds`：条目下架后从远程库存移除，已生成的 disabled draft 保留本地审计信息，不自动启用。
- `killSwitches.global`：全局停用远程策略和 cloud scope MCP。
- `killSwitches.features`：按功能停用高风险能力，例如 `mcp_cloud`、`remote_prompt_fragments`、`capability_registry`。
- release policy rollback：把 production payload 回写到上一 bundle 的 payload，保留 keyId 和私钥不变。

撤回要比发布简单。发布需要 review，撤回只需要可信 bundle 和审计记录。

### 审计与后台管理

P2 的后台/运营面最少要能回答：

- 哪个版本在 production、beta、canary。
- 当前 payload hash、签名 keyId、发布人、发布时间。
- 哪些 capability 条目新增、变更、撤回。
- 哪些 prompt addon 发生变化。
- 哪些用户/版本/entitlement 能看到这次发布。
- 最近一次 smoke 是否通过，失败原因是什么。
- 回滚目标是哪一个 previous bundle。

短期可以先用 manifest 和 release bundle 作为审计资产；后台 UI 可以后置，但发布材料必须先具备这些字段。

### P2 Production 状态

P2 第一版 production 已从空 payload 推进到可运营的最小内容闭环：

- `72e39cf2 feat(control-plane): add release bundle governance` 已推到 `origin/main`。
- `production-2026-05-17.2` bundle 已生成，包含 `manifest.json`、三类 payload、Vercel env commands 和 rollback commands。
- Vercel production 已写入非空 capability registry 与两个受限 prompt addon，并部署到 `dpl_BiNvdAxvKDe6uYCDsQP9hESUnbkm`，`code-agent-beta.vercel.app` 已 alias 到该 deployment。
- 线上 smoke 已通过：cloud config、prompt registry、capability registry 均返回 HTTP 200 signed envelope，`keyId=production-2026-05-17`。
- 当前 production capability registry 发布 3 个 reviewed metadata 条目：Filesystem MCP template、HTTP API channel template、Meeting summary workflow template。MCP 条目仍只允许 disabled draft；channel/workflow 条目只做 metadata preview。
- 当前 production cloud config 仍保持 `entitlement.status=revoked`、`mcpServers=[]`，未向未认证用户打开 cloud MCP 或高风险 feature。

P2 后续治理补充：

- `supabase/migrations/20260517000000_control_plane_governance.sql` 新增 `control_plane_entitlements` 和 `control_plane_audit_events`，并提供 admin-only RPC 读取 audit ledger 与 rollout summary。
- Vercel control-plane 增加 optional audit writer，只有显式配置 `CONTROL_PLANE_AUDIT_ENABLED=true` 时才写入 ledger；写入路径优先使用 Supabase REST URL/service role key，缺少 service role 时可退到 `DATABASE_URL` 直连 Postgres。记录 artifact、version、channel、hash、keyId、subject 和 entitlement 结果，不记录 bearer token、signature 或 payload 全文。
- Settings 管理组新增只读 `Control Plane` 页，复用 Admin IPC 和 Supabase admin RPC 展示最近 audit events 与版本/hash 摘要；migration 尚未应用时页面显示 unavailable reason。

### P2 Non-goals

P2 默认不做这些事：

- 远程 skill 自动启用。
- 远程 MCP 自动连接。
- 第三方 executable plugin 在线安装。
- 第三方 channel adapter 自动接入外部账号。
- 用混淆或 Rust sidecar 承载高价值秘密。

可执行 tool bundle、第三方 channel adapter、插件权限硬闸和沙箱属于更后面的生态化工作。P2 先把远程内容供给管住。

### 附录：客户端逆向成本与发布包复查

这些仍然有价值，但属于 release hygiene：

- JS bundle 混淆和字符串压缩，用在 renderer 和 web server 的 release build。
- 把 license verifier、update verifier、device attestation 的小块逻辑放到 Rust/Tauri sidecar。
- 对本地 database schema、prompt cache、task ledger 做字段级脱敏和版本迁移。
- 对 release app 运行 `codesign --verify --deep --strict`、`spctl --assess`、notarytool 验证。
- 对 DMG 做独立 inventory：挂载 DMG 后扫描 `Contents/Resources/_up_`。

Rust 和混淆只提高成本。高价值秘密只要到了用户机器，就要按“会被看见”处理。

## 保留在客户端的原则

客户端只保留能解释产品行为的最小公开逻辑：UI、IPC 契约、本地执行器、插件草稿、连接器适配、离线 fallback。能决定商业权限、路线策略、隐藏能力、服务端资源访问的东西，默认放服务端。这样就算有人解开 DMG，也只能看到客户端外壳和公共协议，看不到完整产品计划和控制面。

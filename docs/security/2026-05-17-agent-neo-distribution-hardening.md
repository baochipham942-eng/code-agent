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

## P2 逆向成本提升

这些可以做，但优先级低于服务端边界：

- JS bundle 混淆和字符串压缩，用在 renderer 和 web server 的 release build。
- 把 license verifier、update verifier、device attestation 的小块逻辑放到 Rust/Tauri sidecar。
- 对本地 database schema、prompt cache、task ledger 做字段级脱敏和版本迁移。
- 对 release app 运行 `codesign --verify --deep --strict`、`spctl --assess`、notarytool 验证。
- 对 DMG 做独立 inventory：挂载 DMG 后扫描 `Contents/Resources/_up_`。

Rust 和混淆只提高成本。高价值秘密只要到了用户机器，就要按“会被看见”处理。

## 保留在客户端的原则

客户端只保留能解释产品行为的最小公开逻辑：UI、IPC 契约、本地执行器、插件草稿、连接器适配、离线 fallback。能决定商业权限、路线策略、隐藏能力、服务端资源访问的东西，默认放服务端。这样就算有人解开 DMG，也只能看到客户端外壳和公共协议，看不到完整产品计划和控制面。

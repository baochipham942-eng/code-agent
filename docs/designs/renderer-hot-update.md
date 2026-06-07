# 前端热更（Renderer Hot Update）设计

> 状态：实现已闭环，待生产发布与实盘观察
> 目标：改前端 UI 不用整包发版。前端 bundle 独立推 OSS（~1min），不碰 cargo build/公证（~25min）。

## 决策（已拍）

- **生效时机**：以不打断任务和输入为准。webServer 后台拉取+验签+切换到 `active/` 后，当前页面会先保持原 bundle；设置页会在检测到“当前页面加载版本”和 active 目标不一致时提示用户刷新界面生效。全局自动安全刷新只会在没有运行/排队任务、没有后台任务、页面可见、输入框没有焦点且页面空闲一段时间后触发。

## 可行性基石

前端是 webServer serve 出去的（Tauri WebView 拉 `localhost:8180`），**不是 Tauri 直读 bundle 文件**。所以热更只需让 webServer 换 serve 目录，**Tauri 壳/签名/公证完全不动**。

## 双包模型

- **包内基线** `dist/renderer/`：随整包签名发布，永远可信兜底。
- **云端 overlay**：OSS 拉取的 bundle，校验通过后放 `~/.code-agent/renderer-cache/active/`。

## 数据面（serve）— 钩子点 `src/web/routes/static.ts`

`staticDir` 改运行时解析：`renderer-cache/active/` 存在且健康 → 用云端版；否则 fallback 包内 `dist/renderer`。配套：
- index.html 内存缓存（static.ts:29-55）切换时 reset。
- token 动态注入逻辑保留（云端包**不含** token，serve 时注入 `window.__CODE_AGENT_TOKEN__`）。
- 同时注入当前页面实际加载的 bundle 元信息 `window.__CODE_AGENT_RENDERER_BUNDLE__`。builtin / explicit staticDir 注入 `null`；只有当前请求实际 serve 健康的 `renderer-cache/active/` 时才注入 `{version, contentHash}`，设置页据此判断是否需要刷新界面才能用到最新 active。

## 控制面（拉取/验签/切换）— webServer 启动后异步，不阻塞 health

```
默认拉 OSS renderer-bundle/latest/manifest.json（灰度 env 可切到 channels/<channel>；配置 signed rollout policy 后先验 kind=renderer_bundle_rollout，再选择目标 manifest）
 → 契约版本门：minShellVersion > 当前壳版本？ → 拒绝，留当前（防新前端配旧壳崩）
 → 壳能力门：requiredShellCapabilities 有任一缺失？ → 拒绝，留当前
 → contentHash == 本地 active？        → 已最新，skip
 → 下载 bundle.tar.gz → pending/        → 校验 sha256 == manifest.contentHash
 → 验 envelope 签名（复用 controlPlaneTrust）→ 解压 pending/
 → fs.rename(pending → active)          // 同 fs inode 级原子
 → 写 active/.bundle-meta.json（version/hash）→ reset index.html 缓存
 → 写 renderer-cache/last-status.json（最近一次尝试的 outcome / reason / manifest 摘要）
```

## 兜底铁律（与 model 路由 override 一致）

拉取失败 / 签名失效 / sha256 不匹配 / minShellVersion 不满足 / 解压失败 → **一律保持当前**，绝不 serve 半个或损坏的前端。`active/` 校验失败 → 回包内基线。包内基线永远是签名发布的可信底座。

每次启动后台尝试都会写 `renderer-cache/last-status.json`，并通过 `domain:update/rendererBundleStatus` 暴露给设置页；同一份 status envelope 还会写入本地 `telemetry_renderer_bundle_attempts`，由 telemetry uploader 以 metadata-only 方式回传到 Supabase。生产排查可以直接看 outcome：`applied` 表示已切 active，`skipped` 表示按规则保持当前，`failed` 表示下载、验签、完整性或解压流程失败。

设置页的“前端界面”区块会展示当前 active bundle、当前配置入口（latest/channel/manifest override）、最近一次检查 outcome/reason、候选 manifest 的版本门与能力数量，以及缺失的 shell capabilities。排查时不需要直接读本地 JSON，也能判断机器是在使用包内基线、热更包，还是因为入口配置、版本、能力、签名问题跳过。

生产 kill switch：设置 `CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE=1`（兼容别名 `CODE_AGENT_RENDERER_BUNDLE_DISABLED=1`）后，webServer serve 侧直接忽略 `renderer-cache/active/`，使用包内基线；启动后台拉取也会在请求远端 manifest 之前跳过并记录 `reason=disabled`。这用于 OSS latest 配错、签名材料异常或线上需要立刻停止 overlay 时快速回退。

控制面灰度策略：设置 `CODE_AGENT_RENDERER_BUNDLE_ROLLOUT_POLICY_URL` 后，客户端会先拉签名 envelope（kind=`renderer_bundle_rollout`），按策略里的 `paused`、`rollbackToBuiltin`、`channel`、`manifestUrl`、`rolloutPercent`、`cohorts`、`platforms`、`minShellVersion`、`maxShellVersion` 做决策。命中目标后再拉对应 manifest；cohort/platform/percent/version 未命中时回到原配置入口；策略明确 paused 时跳过；策略明确 rollback 时清理 active overlay 回包内基线；策略签名不可信时 fail closed，不继续应用热更。`rendererBundleStatus.lastAttempt.rollout` 会记录策略入口、policyVersion、决策、百分比分桶和 fallback reason。服务端的 `renderer_bundle_rollout` artifact 还支持显式打开 telemetry guard：读取最近 `telemetry_renderer_bundle_attempts`，按 channel 或 manifest hash 聚合 outcome/reason，达到最小样本数和失败率阈值后自动把策略改写为 pause 或 rollback。

远端回滚：`Publish Renderer Bundle` workflow 手动 dispatch 可设置 `rollback_to_builtin=true`，发布一个签名 `renderer_bundle` manifest（`rollbackToBuiltin: true`）到 `renderer-bundle/latest/manifest.json`，不上传新的 bundle。支持该能力的壳启动后拉到 manifest，会删除本机 `renderer-cache/active/` / `pending/`，记录 `outcome=rolled-back`，下一次请求回包内基线。这个路径用于用户机器已经缓存坏 overlay、但还能启动 webServer 后台任务的场景。

## 契约版本门与壳能力门（最高风险点的解法）

IPC 契约（`src/shared/ipc/domains.ts`）当前**无版本号**，新前端配旧壳会 404/INVALID_ACTION/静默崩。`manifest.minShellVersion` vs 壳版本硬门挡住：前端要用新 IPC 就声明高 `minShellVersion`，旧壳拒绝该 bundle、留包内版本，等整包更新壳后再吃新前端。

`manifest.requiredShellCapabilities` 是更细粒度的 ABI 门：能力 ID 形如 `domain:update/check` 或 `native:tauri/desktop_get_capabilities`。壳能力 manifest 与 scanner 现在都会显式标出 `layer=domain|native`；release record 也会输出 required capabilities 的 domain/native 数量，CI 不需要靠字符串前缀猜这次 bundle 是否碰了 native 壳能力。打包脚本默认扫描 `src/renderer` 中静态可见的 `invokeDomain(IPC_DOMAINS.X, 'action')` / `window.domainAPI.invoke(...)` 调用；literal domain 既支持 `'domain:auth'`，也支持能映射到 `IPC_DOMAINS` 的历史 shorthand，例如 `'auth'` / `'workspace'`。脚本也会扫描 `invoke('...')` / `internals.invoke('...')` / `tauriInvoke('...')` 这类直接 Rust/Tauri command 调用，写入 manifest，并对照 `src/main/shellCapabilities.ts` 校验；扫描不到的动态调用要通过 `--required-shell-capabilities` 或重复 `--require-shell-capability` 手动补充。旧壳缺任一能力时拒绝应用该 bundle。因为更老的壳不认识 `requiredShellCapabilities`，只要 manifest 带该字段，打包脚本就要求 `minShellVersion >= 0.16.93`。

非 native 资源依赖单独声明：`manifest.requiredRuntimeAssets` 记录可下载 runtime asset ID，`manifest.requiredResources` 记录包内资源路径或资源 ID。它们现在进入 build manifest、manifest diff、release record 和发布后 verifier，用来审计“这个前端 bundle 多依赖了哪些本地资源”。客户端应用 bundle 前会探测本机 runtime asset 状态和资源路径；声明的 runtime asset 缺失时，会先尝试走现有 runtime assets 预备入口安装资产，再重新跑依赖门，仍缺失才跳过该 bundle，并记录 `missing-runtime-asset` 与 `runtimeAssetPreparation`。包内资源缺失不会触发下载，直接记录 `missing-resource`，保持当前前端。

判断边界也因此更清楚：只加云端接口、webServer domain handler 或纯 renderer 代码，且旧壳 manifest 已有对应 capability，就可以走热更；新前端一旦依赖旧壳没有的 Rust/Tauri command、系统权限、bundle resource 或 native helper，就属于壳能力变化，必须等整包带新壳后再让前端 bundle 命中。

## 签名

复用 `src/main/services/cloud/controlPlaneTrust.ts` 的 `verifyControlPlaneEnvelope`，kind=`renderer_bundle`。公钥已打包（`dist/web/control-plane-public-keys.json`）。webServer 可 `import('../main/...')`，无 main/web 分层障碍（已有大量先例）。

## CI = 省发版的真义

轻量脚本 `build renderer + 扫描 requiredShellCapabilities + 签 manifest + 本地真实 webServer smoke + ossutil 传 OSS + 远端 latest 验证`，**独立于整包发版**。前端改动只跑这条链路，不走 cargo build/公证。OSS 路径：`renderer-bundle/latest/{manifest.json,bundle.tar.gz}` + 版本快照 `renderer-bundle/v${VERSION}/`。手动 workflow 支持 `dry_run=true`：即使缺签名 key / OSS 上传权限，也会生成候选 manifest、manifest diff、release-record 和跑 smoke，但跳过上传与远端发布验证，用于发布前预览。

PR 上会跑 capability diff 和 `npm run acceptance:renderer-hot-update`：改到 renderer、shared contract、web serve、renderer fetcher/cache/policy、control-plane trust、update IPC 或相关脚本时，都会先用真实 `dist/web/webServer.cjs` 验证健康 active 会被 serve、无 active / 不健康 active 会回包内基线、生产 kill switch 会强制忽略 active，token 注入仍然存在，并通过真实 `rendererBundleStatus` HTTP handler 验证 channel source 与入口配置错误可观测。

上传前必须再次跑 `npm run acceptance:renderer-hot-update`。上传后 workflow 仍必须跑 `scripts/verify-renderer-bundle-publish.mjs`：重新从公开 OSS URL 拉 `latest/manifest.json`，用控制面公钥验签，确认 `requiredShellCapabilities` 都属于当前壳 manifest，再按 manifest 的 `bundleUrl` 拉 `bundle.tar.gz` 并校验 sha256，同时拉 `latest/release-record.json` 确认发布记录和 manifest 的 version、hash、rollback、capability count、runtime/resource dependency count/list 以及 channel/cohort/percent 一致。renderer bundle manifest 是静态 OSS artifact，默认签名有效期为 365 天，不继承动态控制面 1 小时 TTL；发布后 verifier 默认要求 manifest 至少还剩 7 天有效期，能挡住短 TTL 误签，特殊发布可以用 `--manifest-ttl-seconds` / `--manifest-expires-at` 调整签名时长，或用 `--min-manifest-validity-seconds` 调整验收窗口。这样 serve 路径回归、`latest` 404、manifest/bundle 不配套、签名失效、短 TTL manifest、hash mismatch、release record 漏传/不一致，或前端要求了当前壳不支持的能力，都会在 workflow 里失败，而不是留给客户端启动时才发现。

生产发布后的最终验收用 `npm run renderer:verify-production -- --expected-version <version>`。这个命令默认只检查热更新必需的 Vercel 签名 `renderer_bundle_rollout` envelope，再检查 OSS 上的 renderer manifest / bundle / release record，并沿用 manifest 至少剩余 7 天有效期的发布闸口；默认验 `latest`，灰度通道可加 `--release-channel beta`，远端 rollback manifest 加 `--allow-empty-required-shell-capabilities`。发布 workflow 在上传 OSS 前会先跑 `--skip-renderer-bundle --retry-attempts 12 --retry-delay-ms 30000`，等待 Vercel 控制面部署完成；上传后完整生产验收也用同样的 bounded retry，覆盖 OSS 传播窗口。需要顺带验全控制面健康时再加 `--full-control-plane-smoke`。如果生产失败面不清楚，加 `--include-remote-snapshot` 会在严格验签仍失败的同时输出 unsigned 远端诊断：manifest 版本/过期状态、release-record HTTP 状态、bundle sha256 是否匹配 manifest payload。这一步回答的是“另一个会话发完以后，生产是否真的具备可控热更入口”，不只回答“OSS 文件有没有传上去”。

整包 release 里的 runtime assets 也按同一条生产闸处理：`Build and Release` workflow 上传 `runtime-assets-manifest-darwin-arm64.json`、`.sha256` 和 archives 后，立刻跑 `scripts/verify-runtime-assets-publish.mjs` 从公开 OSS URL 拉回验签、校验 manifest sha 和每个 archive sha。正式 tag 提升 stable 时，`scripts/build-stable-release-json.mjs` 会把 runtime manifest 与 sha sidecar 写进 `stable/release.json` 的 assets；可选 Cloud API publish payload 也会带 `runtimeAssets.manifestUrl/manifestSha256`，避免资产已经上传但更新检查看不到。

## 长期路线图

### P0：生产可用的安全底座

目标是让“发前端 bundle”这件事可以上线用，而不是只能在本地演示。必须具备：签名 manifest、sha256 完整性校验、`minShellVersion` 门、`requiredShellCapabilities` 门、发布后远端回读 verifier、客户端 `last-status.json`、设置页可观测状态、生产 kill switch、远端签名 rollback manifest。完成这层后，纯 renderer、已有 web/domain IPC、云端接口和不依赖新壳的 UI 改动，才可以稳定走热更。

### P1：扩大可热更面积

把更多“原来以为要整包”的需求拆到不依赖 native 的层：webServer domain handler、云端接口协议、renderer 交互、配置/文案/实验开关、非执行型资源。每次新增接口时同步补 capability manifest，并让打包脚本默认扫描静态 domain IPC 和直接 Tauri command；动态调用必须手写 `--require-shell-capability`。这层的判断标准是：旧壳已经有 handler/command/资源，前端只是重新组合或新增纯 web 逻辑，就能热更。

### P2：更顺滑的生效体验

当前已经具备设置页确认刷新：server 在 HTML 里注入本页面实际加载的 renderer bundle 元信息，设置页把它和 `domain:update/rendererBundleStatus` 的 active 目标比较；如果后台已经应用新 active，或远端 rollback 已清掉 active，就展示“刷新界面生效”。刷新按钮在有运行中会话、全局任务 processing 或 processing session 时禁用，避免打断长任务和工具执行。

全局自动 safe reload 已挂在 renderer app 根部：每分钟轮询 `domain:update/rendererBundleStatus`，发现页面加载版本和 active 目标不一致时，只在没有 running session、processing session、queued/running/cancelling/paused task、后台任务，且页面可见、焦点不在 textarea/input/contenteditable、距离最近一次键盘/鼠标/触摸/输入/拖拽/可见性变化超过空闲阈值时，才自动 `window.location.reload()`。因此热更的“应用到缓存”和“切到当前页面”仍是两步，只是第二步可以在明确安全的任务边界自动发生。

### P3：控制面灰度与自动回滚

把 `renderer-bundle/latest` 从单一入口升级成可灰度的控制面策略：按 app version、用户 cohort、平台、百分比、渠道选择 manifest。发布 workflow 已能把非 `latest` 通道发到 `renderer-bundle/channels/<channel>/`，并把 `channel/cohort/rolloutPercent` 写入 release record；客户端默认仍拉 `latest`，内部灰度机器可先用 `CODE_AGENT_RENDERER_BUNDLE_CHANNEL=beta` 拉 `channels/beta/manifest.json`，或用 `CODE_AGENT_RENDERER_BUNDLE_MANIFEST_URL` 指向一次性 canary manifest。需要服务端统一控制时，配置 `CODE_AGENT_RENDERER_BUNDLE_ROLLOUT_POLICY_URL` 指向 signed `renderer_bundle_rollout` envelope；策略可暂停、回包内基线、指定 channel/manifest、按 cohort/platform/shell version/百分比分桶命中。服务端 telemetry guard 打开后，会按最近 renderer bundle attempts 的失败率自动把策略改写成 pause 或 rollback。`rendererBundleStatus` 会暴露当前 source，包含 channel、manifest override、rollout policy URL、cohort 和入口配置错误；channel 或 policy URL 配置不合法时客户端 fail closed，不会静默回退到 `latest`。状态上报已进入现有 telemetry 回传链路：本地记录 `user/device/appVersion/currentShellVersion/channel/outcome/reason/manifest hash/missing capabilities`，云端新表 `telemetry_renderer_bundle_attempts` 保持 admin-only read。策略决策本身留在本地 `lastAttempt.rollout`，用于判断谁被目标 manifest 命中、为什么回落、为什么暂停或回滚。

### P4：资产与能力分层

runtime assets、模型侧配置、提示词、主题资源、非 native 的 worker/web 资源可以沿热更思路继续拆；Rust/Tauri command、系统权限、entitlement、native helper、二进制依赖、签名/公证内容仍然属于整包发版。当前已经先把 shell capability 分出 `domain/native` 两层，并写入 capability scanner、壳能力 manifest、PR diff 和 release record；runtime asset/resource 依赖也已经有独立 manifest 字段、diff、release record、publish verifier 和客户端应用门。缺失 runtime asset 会触发现有 runtime assets 预备入口并重跑依赖门；预备不可用、安装失败或仍不满足时才记录跳过，包内资源缺失仍然不会被热更下载绕过。

### P5：研发流程产品化

把热更能力变成日常发布工具：PR 上自动跑 capability scanner，标出新增/删除 capability，并在 GitHub Step Summary 里展示当前壳不支持的调用；发布 workflow 在上传前给出 candidate manifest 与线上 latest 的 diff；每次发布生成 `release-record.json/md` 并随版本快照和 latest 一起上传；设置页和内部诊断页展示 active bundle、last attempt、missing capabilities；发布脚本支持 dry-run、rollback、指定 channel/cohort/percent；生产验收脚本把控制面 rollout policy、OSS manifest、bundle hash 和 release record 串成一个命令。当前 dry-run 会完整生成候选 manifest / release record / diff 并跑 smoke，但不会上传 OSS。目标是让前端改动从“问能不能热更”变成“CI 明确告诉你能不能热更、为什么”。

长期边界不变：旧壳没有的本地能力不能靠 renderer bundle 变出来。热更能增强的是前端、web 层、云端协议和已经存在的壳能力组合；一旦要新增 Rust/Tauri command、系统权限或 native helper，就先发整包，让新壳具备能力，再让后续前端 bundle 命中。

## 实现阶段（自底向上，每步 TDD）

1. **契约门 + manifest 类型**（纯函数 `rendererBundlePolicy.shouldApplyRendererBundle`）— 决策核心，最易测
2. **完整性校验**（sha256 + envelope 验签）
3. **缓存目录管理 + 原子切换 + active 健康校验**
4. **static.ts staticDir 运行时解析改造**（含 index.html 缓存 reset）
5. **拉取器编排** + webServer 启动后异步接线
6. **网络常量** OSS renderer-bundle base url
7. **CI 脚本** build+签+传 OSS（独立发版）
8. **验证**：typecheck + 测试 + 端到端（本地起 webServer + 注入假 active/ 验证 serve 切换）

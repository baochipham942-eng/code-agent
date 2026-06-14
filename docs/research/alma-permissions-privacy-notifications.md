# Alma Permissions / Privacy / Sensitive Data / Notifications 对标

日期: 2026-06-14

范围: 权限申请、权限管理、敏感信息处理、隐私/本地优先表达、通知和后台任务打扰控制。明确不做 onboarding 对标。

## 证据边界

委托里列的 0.0.805 到 0.0.823 对比包当前未出现在本机 `/tmp`:

- `/tmp/alma-update-20260613/release-notes-805-823.md`
- `/tmp/alma-update-20260613/old/extract/renderer-assets/index-DZO6LH4W.js`
- `/tmp/alma-update-20260613/new/extract/renderer-assets/index-lrtJ1hZ1.js`
- `/tmp/alma-update-20260613/old/extract/index.js`
- `/tmp/alma-update-20260613/new/extract/index.js`

所以本研究没有做旧/新 bundle diff。Alma 侧证据来自两类:

- 已安装包 `/Applications/Alma.app`，版本 0.0.823；`Info.plist`、entitlements、Chrome extension、bundled skills 直接从 app bundle 复核，main/renderer 证据通过 `/Applications/Alma.app/Contents/Resources/app.asar` 文本检索复核。
- GitHub release notes: [v0.0.805](https://github.com/yetone/alma-releases/releases/tag/v0.0.805), [v0.0.807](https://github.com/yetone/alma-releases/releases/tag/v0.0.807), [v0.0.813](https://github.com/yetone/alma-releases/releases/tag/v0.0.813), [v0.0.820](https://github.com/yetone/alma-releases/releases/tag/v0.0.820), [v0.0.823](https://github.com/yetone/alma-releases/releases/tag/v0.0.823)

证据标记:

- `证实`: 有 release notes、bundle grep、Info.plist、entitlements、当前代码证据。
- `推断`: 从已证实行为和代码结构推出来的产品意图，需要后续用真实 UI 或旧/新 diff 复核。

## 核心判断

Alma 这条线最值得借鉴的是边界表达: 权限通常在用户触发具体动作时解释，桌面、渠道、插件、MCP、浏览器 relay 各自有独立入口，通知策略从 v0.0.820 开始明显往少打扰收敛。

Neo/code-agent 的底层能力更强: permission classifier、policy engine、GuardFabric、Seatbelt、secure storage、secret masking、channel privacy、telemetry scrub、notification focus gate 都已经存在。主要短板是用户可见解释不统一，权限/隐私/通知策略散落在设置页、工具层和服务层，用户很难提前理解一次动作会碰到哪类数据，完整 trace 和短错误摘要的边界也没有形成统一产品规则。

高风险缺口集中在三处:

1. 语音和转写边界: Neo 的 voice paste 可走本地 whisper-cpp，也可回落 Groq；还会用智谱/Kimi 做后处理，且存在转写文本日志。用户触发录音时没有清楚看到本地/云端路径。
2. 诊断和遥测表达: PrivacySettings 文案说当前默认上报元数据，不含完整 prompt/代码内容；但 diagnostic bundle 能把 raw payload 打包，经 scrub 后上传失败诊断包。实现有脱敏，文案边界需要改。
3. 权限策略入口: code 层有权限判断和沙箱，但 settings 里缺一张面向用户的边界地图，channel、desktop、plugin、MCP、provider key 的权限含义没有被放在同一套语言里。

## Alma 侧证据

### 权限申请和管理

证实:

- `Info.plist` 声明了 `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`, `NSCalendarsUsageDescription`, `NSCalendarsFullAccessUsageDescription`, `NSBluetooth*UsageDescription` 和 `NSAllowsLocalNetworking`。麦克风文案是用于 Whisper speech-to-text transcription。
- `codesign` entitlements 含 `com.apple.security.device.audio-input` 和 `com.apple.security.automation.apple-events`，说明桌面自动化和音频输入是签名层能力。
- main process 有通用权限 IPC: `permissions:get-all`, `permissions:open-settings`, `permissions:request`。`accessibility` 会启动授权 flow/overlay；`screen_recording` 通过 `desktopCapturer.getSources({ types: ["screen"] })` 触发 macOS TCC，并打开系统设置。
- renderer 的 SpeechInput 在点击录音时才调用 `window.whisper.requestMicrophonePermission()`；denied/restricted 时设置错误，并打开麦克风系统设置。证据在 `/Applications/Alma.app/Contents/Resources/app.asar` 的 `requestMicrophonePermission` / `SpeechInput` 片段。
- main process 有 `get-microphone-status`, `request-microphone-permission`, `open-microphone-settings`。macOS 下通过 `systemPreferences.getMediaAccessStatus("microphone")` 和 `askForMediaAccess("microphone")`。
- Electron session 的 `setPermissionRequestHandler` 对 `media/microphone/audio` 放行，对其他权限拒绝。这个是浏览器运行层兜底，不等于完整 TCC 授权体验。
- MCP/OAuth 有独立 IPC: `mcp-oauth-get-status`, `mcp-oauth-start`, `mcp-oauth-revoke`。
- ACP tool permission 有 `Allow ACP Tool Permission?` 弹窗，带 tool title/kind/input 和 Allow/Deny。
- Chrome Relay extension manifest 请求 `debugger`, `tabs`, `activeTab`, `storage`, `alarms`, `host_permissions: <all_urls>`，options 页里 auth token 是 password input，带 show/hide。background.js 从 Alma 本地 server 自动拉 port/token，并用 WebSocket token 连接。
- bundled `computer-use` skill 写明 Accessibility dialog 只在 `computer-use__grant` 或 `alma cu grant` 时触发；其他 AX 调用缺权限会 fail fast，错误码为 `ax_not_granted`，截图需要 Screen & System Audio Recording，错误码为 `sc_not_granted`。
- v0.0.813 release notes: tool calling support through MCP bridge。v0.0.807 release notes: Settings 新增 Plugins & Providers。

推断:

- Alma 在权限申请上更偏 just-in-time: 用户点击录音、授权 Computer Use、连接 MCP OAuth、配置 Chrome Relay 时才暴露对应权限，不把所有权限提前塞给用户。
- 它把桌面权限、渠道认证、MCP OAuth、provider/plugin 设置拆成不同入口，降低了“一个总权限开关到底授权了什么”的模糊感。

### 敏感信息和隐私表达

证实:

- v0.0.807 release notes 把 Alma 文档定位为 `local-first, memory-first AI agent`。
- 当前 app 依赖包含 `@fugood/whisper.node`, `@fugood/node-whisper-darwin-arm64`，renderer 会检查本地 Whisper model 是否已下载，然后本地初始化和转写。
- v0.0.820 release notes 明确写到 Feishu/Lark voice messages 会自动下载和 speech-to-text；同时 voice transcription in Feishu no longer depends on desktop Whisper setting。这说明渠道语音转写和桌面 Whisper 设置被拆边界。
- v0.0.820 release notes 明确错误回复只发 short summary，避免 full stack trace。
- bundled `voice` skill 写明本地 Qwen3-TTS: no API key, no internet required。
- Chrome Relay token 存在 `chrome.storage.local`，options 页允许查看/保存 token。

需要警惕:

- renderer 里 `console.log("[SpeechInput] Transcription result:", result.text)` 会把转写文本打进前端日志。这和“语音内容是敏感数据”的预期有冲突。
- Chrome Relay 拥有 `<all_urls>`、debugger、tabs 权限，能看到 cookies/session 所在浏览器上下文。它通过 token 做连接保护，但仍应在产品上明示“这是浏览器控制权限”，不能只当普通插件。
- `local-first, memory-first` 是文档表达，不等于所有路径都本地。Feishu voice transcription 的实际 provider 需要继续从 channel 代码或运行配置确认。

### 通知和后台任务打扰控制

证实:

- v0.0.820 release notes:
  - Feishu typing indicator 显示 reply is being prepared。
  - Reduced noisy progress message spam during task processing in Feishu。
  - Channel conversations no longer trigger desktop reply notifications。
  - Fixed duplicate replies in Feishu。
  - Error replies send only a short summary instead of full stack trace。
- current main bundle 有 `alma-notification:public-notify`, `public-clear-all`, `public-test`, notification queue、theme、dismiss/action/click/presented 事件。
- current notification renderer 有 queue count、auto-dismiss timer、hover pause、progress bar、actions、clear all、dismiss。

判断:

- Alma 的通知策略在 v0.0.820 做了清晰取舍: 渠道里用 typing indicator 保留任务可感知性，桌面通知不再为渠道回复弹出；progress 不刷屏，错误只发短摘要。
- 这套策略适合 Neo 借鉴: 桌面通知只管需要用户介入和任务完成；过程态留在任务所在表面，不跨表面打扰。

## Neo/code-agent 当前实现核验

### 权限、沙箱、审批

证实:

- `src/main/tools/permissionClassifier.ts`: 只读工具和网络只读工具自动批准；危险 bash 模式 deny/ask；读取 `~/.codex/memories`、Claude memory 目录会 ask；写项目内或 `/tmp` 可 approve，写项目外 ask；MCP 工具默认 ask。
- `src/main/permissions/modes.ts`: 有 default、acceptEdits、dontAsk、bypassPermissions、plan、delegate 六种模式，bypass 需要显式 approval，plan 是 read-only exploration。
- `src/main/permissions/policyEngine.ts`: block root writes、block SSH private key access、prompt env file writes、prompt sudo/force push、allow git status/log/diff/show 和 ls，带 audit。
- `src/main/permissions/guardFabric.ts`: 多 source 裁决，topology-aware；async_agent 的 bash/coordinator 的 write/edit 等会被 topology rule 拦截；deny 优先于 ask，ask 优先于 allow；async_agent fail closed 到 deny。
- `src/main/permissions/hookSource.ts`: HookGuardSource 还是 placeholder，当前不参与实际权限裁决。这是明确实现缺口。
- `src/main/sandbox/seatbelt.ts`: macOS sandbox 默认禁止网络，禁止所有写入，再放行 `/dev`、temp、workingDirectory 和显式 writePaths。读没有默认收紧，代码注释解释这是为了避免 macOS 动态链接阶段崩溃。
- `src/shared/contract/permission.ts`: permission request 有 file/network/mcp/dangerous command 类型、once/session/always/never 审批级别、preview、dangerLevel 和 decisionTrace。

判断:

- Neo 的能力层强于 Alma 当前能看到的证据，尤其是工具权限分类、拓扑隔离、沙箱和 decisionTrace。
- 产品层弱于 Alma: 用户动作触发时看到的“为什么问、这次会碰什么数据、授权后持续多久”还没有统一可见语言。

### 敏感信息、隐私、token 存储

证实:

- `src/main/security/sensitiveDataGuard.ts`: 面向 prompt、memory、activity、knowledge、transcript、export、telemetry 七类 surface；对 URL token、secret key、email、IP、SSN、信用卡、截图/音频路径做脱敏；对 prompt injection 文本做 neutralize；对象按敏感 key 递归 redaction。
- `src/main/security/sensitiveDetector.ts`: 覆盖 OpenAI/Anthropic/AWS/GitHub/GitLab/npm/PyPI/Docker/Slack/Discord/Stripe/Twilio/SendGrid/JWT/Bearer/basic auth/private key/database URL 等。
- `src/main/channels/privacy/channelPrivacyFirewall.ts`: channel privacy 默认 `local-redact`；`allow-raw` 才保留 raw；普通模式会脱敏 sender name、chatName、content、attachments，并把 raw 里的 content/text/body/raw/token/secret/password/authorization/cookie 变成 `[redacted]`。
- `src/renderer/components/features/settings/tabs/ChannelsSettings.tsx`: channel modal 有 privacyMode，下拉值为 `local-redact`, `allow-raw`, `off`；HTTP API key、Feishu appSecret/encryptKey/verificationToken、Telegram botToken 都默认 password input，show/hide 控制。
- `src/main/services/core/secureStorage.ts`: API key 进 cache、Keychain 和 encrypted electron-store backup；Keychain 内容可用 Electron safeStorage 加密。`getStoredApiKeyProviders()` 只返回 provider 列表。
- `src/main/ipc/settings.ipc.ts`: 非 admin 获取 settings 时删除 provider `apiKey`，只保留 `apiKeyConfigured`；删除 cloud apiKey、langfuse secretKey、mcp、budget、sanitization、confirmationGate，bypassPermissions 对非 admin 显示为 default；service key 列表只展示前 8 位加 `...`。
- `src/renderer/components/features/settings/tabs/ModelSettings.tsx`: provider UI 以 `apiKeyConfigured` 判断是否已配置；保存时可写入 provider apiKey，但读取侧不会直接暴露完整 key。
- `src/main/telemetry/telemetryUploaderService.ts`: 自动上传 turn 是 metadata-only，不含 prompt/completion/tool args/result；错误经过 `scrubString`；未登录不传。
- `src/main/telemetry/diagnosticBundleService.ts`: diagnostic bundle 会包含 raw payloads，上传/导出前调用 `sanitizeDiagnosticBundle`，清洗 home dir 和 secrets；注释明确 raw 上没有跑 GLiNER 深度 PII，性能原因。
- `src/shared/observability/scrubEvent.ts`: Sentry 事件清洗会丢弃 request data/cookies，清洗 prompt、completion、input、output、body、code/sourcecode/filecontent 等敏感 key。
- hook 日志: `src/main/hooks/hookManager.ts` 记录 trigger history 前 mask message；`src/main/hooks/scriptExecutor.ts` 对 hook stderr、command、error 做 mask；测试 `tests/unit/hooks/hookSanitizationAndTrace.test.ts` 覆盖 API key/GitHub token 不进入 trigger history。
- MCP: `src/main/mcp/mcpToolRegistry.ts` 按 MCP annotations 映射权限，destructive 需要 execute permission，readOnly 且非 openWorld 不需要 permission，默认 network permission；MCP 调用日志对 token/password/secret/api_key/authorization/auth/credential 递归 redaction；超大输出落盘并给模型返回 spill notice。

需要警惕:

- `PrivacySettings.tsx` 文案说“当前版本默认上报运行轨迹的元数据，不含完整 prompt/代码内容”，但失败诊断包会在 scrub 后上传 raw payload。实现不是裸传，风险可控，但文案需要把“自动 metadata”和“失败诊断包/用户导出”分开。
- `useVoiceInput.ts` 通过 `navigator.mediaDevices.getUserMedia` 录音，然后 `ipcService.transcribeSpeech(audioData, mimeType)`；注释写 Groq Whisper API。`voicePaste.ipc.ts` 先试本地 whisper-cpp，失败后 Groq；后处理还会读 `.env` 里的 ZHIPU/KIMI key 调外部模型。这个边界在 UI 里不够清楚。
- `voicePaste.ipc.ts` 会 `console.log('[VoicePaste] Pasted:', cleanText.substring(0, 50) + '...')`，这仍然是敏感内容片段。
- ChannelsSettings 的 HTTP API key 列表展示前 8 位并提供“复制完整 key”。这是管理功能，可以保留，但需要更明确的“复制会把完整 key 放入剪贴板”提示。

### 通知和后台任务

证实:

- `src/main/services/infra/notificationService.ts`: 系统通知只记录 `needs_input` 和 `task_complete`；默认只在 app 失焦时通知；后台任务完成可 `force` 绕过焦点门；通知正文是 summary 或工具数量和耗时。
- `notifyNeedsInput` 用于权限请求、用户提问；`notifyTaskComplete` 用于任务成功/失败完成。
- `src/main/session/backgroundTaskManager.ts`、`src/main/tasks/backgroundTaskLedger.ts`: 后台任务有 ledger、events、queued notification、delivered 标记。完成/失败会触发通知服务。
- `src/main/ipc/notification.ipc.ts`: renderer 只能 get recent 和 report delivery，没有任意写通知入口。

判断:

- Neo 已经接近 Alma v0.0.820 的通知方向: 过程态不应该弹桌面通知，系统通知只出现在“需要用户介入”或“任务结束”。
- 还缺统一的通知 policy 文档和代码入口，避免后续 channel、loop、cron、background task 各自加一套 progress notification。

### 设置页可见性

证实:

- `PrivacySettings.tsx`: 有“隐私防线”和“使用数据上报 Telemetry”两块；本地 PII 防线描述为 GLiNER ONNX，本地运行，首次下载约 190MB 到 `~/.cache/code-agent/gliner-pii/`。
- `ChannelsSettings.tsx`: 能配置 HTTP API、Feishu、Telegram，通道状态和隐私策略可见，但 privacyMode 是 raw enum。
- `MCPSettings.tsx`: 有 MCP 管理台、发现连接、云端刷新、添加 server、启用/禁用、重新授权；admin 才看到“运行状态与本地桥接”里的 LocalBridge 和 NativeConnectors。
- `AppshotsSettings.tsx`: 明确写应用截图需要屏幕录制截窗、辅助功能读取窗口文本，并提供打开系统设置按钮。
- `NativeConnectorsSection.tsx`: macOS 原生连接器支持检查授权、修复权限、断开、移除；但位于 MCP 详情区域下，用户不一定能从“权限”角度发现。

判断:

- Neo 有“局部解释”，缺“总览地图”。Alma 的启发是按边界拆清楚: 桌面采集、语音转写、渠道入口、MCP/插件、provider/API key、通知，各自告诉用户何时触发、会读写什么、存在哪里、如何撤回。

## 对标矩阵

| Alma 体验点 | 用户感知 | Neo 现状 | 差距类型 | 优先级 | 开发/设计建议 |
|---|---|---|---|---|---|
| 录音时申请麦克风，denied 后打开系统设置 | 权限和动作绑定，知道为什么要麦克风 | `useVoiceInput`/`voicePaste` 有录音能力，但云端/本地转写路径不透明 | 高风险缺口 | P0 | 录音按钮旁显示“本地/云端转写路径”，首次使用弹 just-in-time 说明 |
| Screen Recording/Accessibility 分开处理 | 桌面控制权限能拆开理解 | Appshots 有说明，Computer Surface 有 permission_denied，但入口分散 | 产品表达问题 | P1 | 做“桌面能力”边界页: 截图、窗口文本、自动点击、系统音频分别列出 |
| `computer-use__grant` 才触发 AX prompt，其他调用 fail fast | 不会无缘无故弹系统权限 | Neo 原生 connector 有修复权限，Appshots 可打开设置 | 产品表达问题 | P1 | 权限请求文案统一成“触发动作、需要权限、失败时怎么修复” |
| MCP OAuth 独立 start/status/revoke | 授权关系可撤回 | MCP 管理台有重新授权、启用/禁用，工具权限映射强 | 表达不足 | P1 | MCP server 详情显示 auth 类型、token/env 存储位置、撤回入口 |
| ACP tool permission 弹窗带 tool input | 知道本次工具要做什么 | Neo permission request 有 preview 和 decisionTrace | 能力强，UI需统一 | P0 | permission dialog 展示“动作、数据边界、持续时间、decisionTrace” |
| Chrome Relay token + debugger/tabs 权限 | 浏览器控制是单独边界 | Neo managed browser/relay 有 recovery summary 和 tokenHint | 表达不足 | P1 | 浏览器控制页单独写明 cookies/session、截图、DOM/AX snapshot 边界 |
| v0.0.807 local-first/memory-first 表达 | 信任来自定位和默认行为 | Neo 有本地 PII 防线和 secure storage，但主线表达分散 | 产品表达问题 | P1 | Privacy 页改成“本地优先、云端例外、诊断例外”三段 |
| Feishu voice transcription 与桌面 Whisper setting 解耦 | 渠道语音和桌面语音不是一回事 | Neo voice paste、desktop audio、channel voice 边界未统一 | 高风险缺口 | P0 | 建 voice/transcription boundary registry，渠道/桌面/会议分别声明 |
| Error replies short summary，不发 full stack trace | 渠道里不泄露内部栈 | Neo error classifier 强，handler 会保留日志，channel 策略需统一 | 高风险缺口 | P0 | channel/user-facing 只发短摘要，完整 trace 进本地诊断包，开发模式可展开 |
| Reduced Feishu progress spam | 任务可见但不刷屏 | Neo notification service 只 needs_input/task_complete，方向正确 | 策略待固化 | P0 | 做 notification policy，禁止 progress desktop spam |
| Channel conversations 不触发 desktop reply notifications | 渠道表面和桌面表面不互相打扰 | Neo channel/desktop notification 边界需核对并声明 | 产品表达问题 | P1 | Channel settings 加“桌面通知策略”说明和开关 |
| Typing indicator 替代 progress spam | 对方知道正在处理，不被消息刷屏 | Neo 外部 channel 需要类似 in-channel low-noise state | 能力缺口 | P1 | Feishu/Telegram/HTTP API 支持低噪状态事件，桌面不弹 progress |
| Notification queue + auto-dismiss | 浮层轻量可清理 | Neo 当前是系统通知和 recent ledger | 体验差异 | P2 | 先不做浮层，P0 聚焦策略，不追 UI 动效 |
| Plugin/provider settings 可见 | 外部能力集中配置 | Neo Model/MCP/Plugins/Channels 各有页 | 信息架构问题 | P1 | 增加“权限与数据边界”索引页，不搬空原设置页 |
| Tool output cut off saved to file | 长输出不塞爆上下文 | Neo MCP 超大输出也 spill 到文件 | 已对齐 | 保持 | 文案里写“完整输出保留本地，可按需打开” |

## 建议开发切片

### P0: Permission and Data Boundary Registry

目标: 建一张运行时可复用的边界表，让权限弹窗、设置页、日志/诊断、通知策略共用同一套事实。

范围:

- 定义 boundary id: `desktop.screen_capture`, `desktop.accessibility`, `desktop.audio.microphone`, `desktop.audio.system`, `channel.feishu`, `channel.telegram`, `mcp.server`, `plugin`, `provider.api_key`, `browser.relay`, `memory`, `telemetry.diagnostic`。
- 每个 boundary 记录: 触发动作、会读取的数据、会写入/存储的位置、是否出云端、默认脱敏策略、撤回/关闭入口。
- PermissionRequest 增加 boundary id 和 short reason，permission dialog 使用这套文案。
- 只在用户动作发生时解释，不提前展示一屏恐吓式权限清单。

验收:

- 针对录音、Appshots、MCP add server、channel connect、provider key 保存各触发一次，弹窗/提示都显示 boundary id 对应文案。
- 单测覆盖 registry 文案存在、敏感 boundary 默认不缺 storage/cloud/redaction 字段。
- UI 中不再出现 raw enum 作为唯一解释，例如 `local-redact` 必须有中文说明。

风险:

- 文案过多会挡任务流。解决方式是弹窗显示一行摘要，展开后看详情。
- boundary 表和真实实现漂移。解决方式是在关键工具注册时引用 boundary id，缺失则测试失败。

### P0: Sensitive Data Redaction and Trace Boundary

目标: 用户可见错误永远短，开发诊断可追完整上下文，但默认脱敏。

范围:

- 定义 user-facing error、channel reply、notification body、dev trace、diagnostic bundle 五类输出面。
- channel reply 默认只发短摘要和 retry hint，不发 stack trace、tool args、token、raw prompt。
- full trace 只进入本地日志/诊断包，上传前必须过 `sanitizeDiagnosticBundle` 和 secret detector。
- voice/transcription 文本不得默认进入 console/log；开发诊断入口只记录长度、provider、duration、错误码。
- Clipboard 复制 API key、导出诊断包这类动作给一次轻提示。

验收:

- 构造含 `sk-...`、GitHub token、cookie、绝对路径、stack trace 的错误，channel reply/notification 不含敏感串。
- diagnostic bundle 含 scrub 后内容，原始 token 不出现。
- VoicePaste 不再 log `cleanText.substring(...)`。
- PrivacySettings 文案区分 metadata telemetry、失败诊断包、用户手动导出。

风险:

- 脱敏过度影响排障。保留 admin/dev 本地 trace drawer，明确只在本机显示。
- 部分第三方 SDK 错误对象结构复杂。用 recursive scrub 做兜底。

### P0: Notification Policy Gate

目标: 把“只在需要用户介入或任务完成时打扰”固化成代码和验收，不靠各业务自觉。

范围:

- 建 notification policy: `needs_input`, `task_complete`, `task_failed` 可出系统通知；`progress`, `typing`, `stream_delta`, `tool_started` 不出系统通知。
- channel 任务过程态走 in-channel typing/progress indicator，桌面不弹 reply notifications。
- background task completion 保留 force，但正文必须短摘要，不带 raw output。
- notification body 统一走敏感信息 scrub。

验收:

- E2E dry-run: 前台普通 progress 不产生 recent notification；app 失焦的 permission request 产生 needs_input；后台任务完成产生 task_complete。
- channel conversation 完成不触发 desktop reply notification，除非用户明确开启某个 channel 的完成提醒。
- failure notification 不含 stack trace 和 token。

风险:

- 用户可能错过长任务中间状态。解决方式是任务详情页保留进度，系统通知只负责完成/失败。

### P1: Boundary Settings Index

目标: 不重构原设置页，只新增一张“权限与数据边界”索引，把已有设置串起来。

范围:

- 展示桌面、语音、渠道、MCP/插件、模型 provider、Memory、Telemetry 七块。
- 每块显示状态、最近一次使用、数据路径、本地/云端、关闭/撤回入口。
- 普通用户只看安全摘要；admin 能看到 bridge、diagnostic、完整配置路径。

验收:

- 从索引可跳转到 Appshots、Channels、MCP、Model、Privacy、NativeConnectors。
- 非 admin 不暴露完整 key、MCP raw config、sanitization internals。
- 所有链接无死路。

风险:

- 容易变成第二套设置页。原则是索引只解释和跳转，不承载复杂编辑。

### P1: Voice and Transcription Boundary Split

目标: 把桌面语音输入、voice paste、会议/桌面音频、channel voice transcription 拆清楚。

范围:

- UI 显示当前转写 provider: 本地 whisper-cpp、本地 Qwen/ASR、Groq、其他云端。
- 首次使用云端转写前提示“音频会发送到外部服务”；本地路径提示模型位置和临时音频清理。
- channel voice transcription 不继承桌面 Whisper setting，文案上明确独立配置。

验收:

- 本地 whisper 存在时走本地并显示本地。
- 本地缺失回落 Groq 前有明确提示或配置开关。
- 临时音频文件在成功/失败后清理，测试覆盖。

风险:

- 强提示会打断语音输入手感。只在首次或 provider 变化时提示。

### P1: Token and Auth Inventory

目标: 把 API key、OAuth、channel token、browser relay token、MCP env/header auth 分开管理和展示。

范围:

- provider API key 继续 secure storage + keychain。
- channel token/appSecret/botToken 默认隐藏，复制完整 token 时提示。
- MCP server env/header 中疑似 secret 的值只显示 configured/masked。
- OAuth 显示 connected/revoke/reauthorize，不展示 token。
- Browser relay 显示 token hint、extension path、connected tab count，强调 debugger/tabs 权限。

验收:

- 搜索设置页 DOM 或 IPC payload，普通用户拿不到完整 provider key。
- MCP/Channel 列表默认不显示完整 secret。
- revoke/disable 后状态更新准确。

风险:

- 现有 channel HTTP API key 复制行为会被误认为泄露。保留管理入口，但把“复制完整 key”改成显式动作。

### P1: MCP / Plugin Permission Copy

目标: 把 MCP/插件的能力范围从“工具数量”变成“会访问什么”。

范围:

- MCP server 详情显示 transport、tools/resources count、auth type、permission mapping。
- 插件详情显示 permissions、events/hooks、是否能调用外部服务。
- destructive/openWorld MCP tool 在调用前显示风险摘要。

验收:

- destructiveHint 工具触发 execute permission。
- readOnly 且非 openWorld 工具不打扰。
- openWorld/read-write 工具弹窗里显示 serverName/toolName 和数据边界。

风险:

- MCP annotations 不可靠。默认仍按 network/ask 处理，annotation 只降低已知安全工具的打扰。

## 实施路线

这条线不要先做大设置页重构。先把运行时事实收成一套可复用 contract，再让权限弹窗、隐私页、渠道回复和通知服务共同引用它。这样改动顺序更接近用户信任链路: 用户动作触发、系统解释数据边界、敏感内容默认脱敏、通知只在需要介入或完成时出现。

### Milestone 0: 锁定事实和测试保护

目标: 在改产品前先给现有能力补一层可验证的事实边界，防止后续文案和真实行为漂移。

主要文件:

- `src/shared/contract/permission.ts`
- `src/main/tools/permissionClassifier.ts`
- `src/main/tools/toolExecutor.ts`
- `src/main/security/sensitiveDataGuard.ts`
- `src/main/services/infra/notificationService.ts`
- `src/renderer/components/features/settings/tabs/PrivacySettings.tsx`
- `src/renderer/components/features/settings/tabs/ChannelsSettings.tsx`
- `src/renderer/components/features/settings/tabs/MCPSettings.tsx`

验收:

- 现有 permission、privacy、MCP、notification 相关测试先跑通，作为改动前基线。
- 新增 contract 测试时必须覆盖 storage、cloud、redaction、revoke/disable 四类字段；敏感边界缺字段直接失败。
- 文案不直接绑定实现 enum。比如 `local-redact` 可以保留为配置值，但用户侧必须显示“默认脱敏”这类可读解释。

### Milestone 1: P0 Boundary Registry 先落地

目标: 建一张统一边界表，让工具权限、设置页解释、语音转写、渠道和诊断都能引用同一事实来源。

推荐改动:

- 新增共享 contract，例如 `src/shared/contract/permissionBoundary.ts`，定义 boundary id、触发动作、数据访问、存储位置、云端路径、脱敏策略、撤回入口。
- `PermissionRequest` 增加可选 boundary 字段，`ToolExecutor` 对 shell、文件、MCP、web、voice、desktop capture 等常见工具填入 boundary。
- 权限弹窗只展示一行摘要和关键数据访问，详情再展开。不要把完整边界表一次性塞给用户。
- `PrivacySettings` 只增加索引式解释和跳转，不重做设置页编辑能力。

验收:

- Appshots、MCP add server、外部文件写入、provider key 保存、语音输入至少各有一条 boundary 映射。
- 权限弹窗里能看到“这次为什么问、会访问什么、授权持续多久”。
- 非 admin 设置读取仍不暴露完整 provider key、MCP raw config、channel secret。

### Milestone 2: P0 Sensitive Data / Trace Boundary

目标: 用户可见错误和渠道回复默认短摘要，完整 trace 留在本机诊断路径，并且上传/导出前脱敏。

推荐改动:

- 增加 user-facing error summarizer，供 channel reply、streaming error、notification body 共用。
- `ChannelAgentBridge`、`ChannelManager` 这类外部通道回复点不直接发送原始 `error.message`。
- `voicePaste.ipc.ts`、`speech.ipc.ts` 不记录转写内容片段，只记录 provider、duration、字符数、错误码。
- `PrivacySettings` 把 metadata telemetry、失败诊断包、用户手动导出拆开表达。

验收:

- 构造含 API key、cookie、路径、stack trace 的错误，channel reply 和 notification body 不含敏感串。
- diagnostic bundle 仍能保留排障所需结构，但原始 token 不出现。
- 语音转写日志不再出现 `substring(0, 50)` 这类内容片段。

### Milestone 3: P0 Notification Policy Gate

目标: 把“只在需要用户介入或任务完成时打扰”收成代码规则，避免 channel、background task、cron、loop 各自加 progress notification。

推荐改动:

- 新增 notification policy helper，只有 `needs_input`、`task_complete`、`task_failed` 能出系统通知。
- `progress`、typing、stream delta、tool started、ordinary channel reply 默认只留在任务表面或渠道表面。
- `notificationService` 入系统通知前统一 scrub 和截断正文。
- channel 设置里说明默认桌面低打扰策略，必要时再加 per-channel 完成提醒开关。

验收:

- 前台 progress 不产生 recent notification。
- app 失焦时 permission request 产生 `needs_input`。
- 后台任务完成产生 `task_complete`，失败通知不含 stack trace/token/raw output。
- channel conversation 完成不触发桌面 reply notification，除非用户显式打开 channel 完成提醒。

### Milestone 4: P1 信息架构补齐

目标: 在 P0 事实和策略稳定后，再把用户能理解和管理的入口补齐。

推荐改动:

- 权限与数据边界索引页: 桌面、语音、渠道、MCP/插件、模型 provider、Memory、Telemetry 七块，只做解释和跳转。
- 语音与转写边界: 聊天语音、voice paste、桌面音频、channel voice 四条路径分开说明 provider、本地/云端、临时文件清理。
- Token/Auth inventory: provider API key、channel token、MCP env/header、MCP OAuth、browser relay token 分开显示状态和撤回入口。
- MCP/Plugin copy: server/plugin 详情显示 transport、auth type、tools/resources count、permissions、hooks、外部服务风险。

验收:

- 设置搜索能搜到 “语音转写”、“诊断包”、“channel token”、“MCP OAuth”、“browser relay”、“插件权限”。
- MCP/Channel/Plugin 列表默认不显示完整 secret。
- 所有索引跳转能到已有设置页，不引入第二套编辑表单。

### 完成判定

这条线完成时，不能只看单测绿。要同时满足三类证据:

- 运行时证据: 权限请求、错误回复、通知发放都引用同一套边界/脱敏/通知规则。
- 用户可见证据: 录音、Appshots、MCP、渠道、provider key、诊断包这些入口都能解释数据会去哪里、怎么撤回、是否出云端。
- 回归证据: P0/P1 覆盖的单测和相关 renderer 测试通过，`npm run typecheck` 通过，`git diff --check` 无格式问题。

## 需求追踪和实现前基线

| 要求 | 当前证据 | 当前状态 | 后续 slice |
|---|---|---|---|
| 权限请求在用户动作发生时解释清楚 | Alma 录音、Computer Use、MCP OAuth 是 just-in-time；Neo 有 `PermissionRequest.preview`、`decisionTrace` 和 permission classifier | 能力存在，解释语言分散 | Milestone 1 |
| 敏感信息默认脱敏，保留开发诊断入口 | `sensitiveDataGuard`、`sensitiveDetector`、channel privacy firewall、diagnostic bundle scrub 已存在 | 底层较强，但 voice/channel/error 输出面不统一 | Milestone 2 |
| 通知只在需要用户介入或任务完成时出现 | `notificationService` 只有 `notifyNeedsInput` / `notifyTaskComplete` 两个主要入口；background task 会触发完成通知 | 方向正确，但没有集中 policy helper 和正文 scrub gate | Milestone 3 |
| 渠道、桌面、插件、MCP 权限边界分开表达 | Settings 里有 Appshots、Channels、MCP、Privacy 局部解释；Alma 把 Chrome Relay、MCP OAuth、Computer Use 分开 | 局部可见，总览缺失 | Milestone 4 |
| 错误短摘要和完整 trace 分边界 | Alma v0.0.820 明确 channel 错误只发 short summary；Neo 有 error classifier 和本地日志 | `ChannelAgentBridge` / `ChannelManager` 仍会把 `error.message` 作为外部错误回复来源 | Milestone 2 |
| API key、OAuth、channel token、transcription、memory 存储和展示策略 | Secure storage、settings sanitization、MCP OAuth、channel password input 都存在 | 缺统一 auth inventory；ChannelsSettings 仍展示 raw privacy enum | Milestone 4 |
| 语音转写边界 | Neo 聊天语音走 Groq Whisper；voice paste 本地 whisper-cpp 失败后回落 Groq，并可用智谱/Kimi 后处理 | 用户触发前缺本地/云端说明；`voicePaste.ipc.ts` 当前会 log `cleanText.substring(0, 50)` | Milestone 2 / 4 |

实现前基线，2026-06-14:

- 批量命令: `npx vitest run tests/unit/tools/permissionClassifier.test.ts tests/unit/permissions/guardFabric.test.ts tests/unit/cli/permissionPolicy.test.ts tests/unit/channels/channelPrivacyFirewall.test.ts tests/unit/channels/feishuPrivacy.test.ts tests/unit/channels/feishuChannelPrivacySmoke.test.ts tests/unit/security/sensitiveDataGuard.test.ts tests/unit/security/sensitiveDetector.test.ts tests/unit/telemetry/diagnosticBundleService.test.ts tests/unit/telemetry/telemetryUploaderService.test.ts tests/unit/telemetry/telemetryRawPayloads.test.ts tests/unit/mcp/mcpToolRegistry.test.ts tests/unit/mcp/logCollector.redaction.test.ts tests/unit/ipc/settingsAccess.ipc.test.ts tests/renderer/components/channelsSettings.management.test.ts tests/renderer/components/mcpSettings.status.test.ts tests/renderer/utils/settingsIndex.test.ts tests/channels/channelMessageReply.test.ts`
- 结果: 16 个 test files 通过，`tests/unit/telemetry/diagnosticBundleService.test.ts` 和 `tests/unit/telemetry/telemetryRawPayloads.test.ts` 在批量并发里 `beforeEach` 超时。
- 复跑: `npx vitest run tests/unit/telemetry/diagnosticBundleService.test.ts tests/unit/telemetry/telemetryRawPayloads.test.ts --pool=forks --maxWorkers=1`，2 个 test files / 8 tests 通过。
- 解释: 当前可把并发超时当成批量运行噪音，但后续实现验收时要用串行复跑补强 telemetry 证据。

当前缺口要补测试:

- `voicePaste.ipc.ts` 不记录转写正文片段，只记录长度、provider、duration、错误码。
- channel/user-facing error 不输出 stack trace、token、raw `error.message`。
- notification policy helper 明确拒绝 progress/typing/tool_started/channel_reply 系统通知，并统一 scrub title/body。
- Privacy/Channels/MCP settings 渲染测试覆盖可读文案，不再只暴露 `local-redact` / `allow-raw` / `off`。

## Issue / PR backlog

实现阶段建议按下面顺序切 PR。核心原则: 先让运行时事实统一，再补用户可见解释；先阻断泄露和打扰，再补信息架构。

| ID | 标题 | 目标 | 主要文件 | 验收 | 依赖 |
|---|---|---|---|---|---|
| PR-0 | Baseline guard | 固化现有权限/隐私/通知/MCP 测试基线，避免后续无法判断回归 | 不改产品代码；只允许补测试说明或 CI 运行说明 | 现有基线测试可复跑；telemetry 两个文件串行通过 | 无 |
| PR-1 | Permission boundary contract | 建统一 boundary registry，并把 PermissionRequest 和 ToolExecutor 接上 | `src/shared/contract/permission.ts`, `src/main/tools/toolExecutor.ts`, PermissionDialog 组件 | boundary contract 单测；权限弹窗能显示动作、数据、持续时间；非 admin settings 仍不暴露 secret | PR-0 |
| PR-2 | Sensitive output boundary | 把 channel reply、notification body、voice transcript logs 的敏感输出收口 | `src/main/channels/channelAgentBridge.ts`, `src/main/channels/channelManager.ts`, `src/main/ipc/voicePaste.ipc.ts`, `src/main/ipc/speech.ipc.ts`, `src/main/security/*` | 含 token/stack/path 的错误不会出现在 channel reply/notification；voice logs 不含正文片段 | PR-1 可并行前半，但最终需引用同一 redaction 规则 |
| PR-3 | Notification policy gate | 建系统通知准入策略，禁止 progress spam 和普通 channel reply 弹桌面通知 | `src/main/services/infra/notificationService.ts`, background task / loop / cron 调用点, notification IPC tests | `needs_input`、`task_complete`、`task_failed` 可通知；progress/typing/tool_started/channel_reply 不通知；正文 scrub | PR-2 |
| PR-4 | Boundary settings index | 在设置里增加权限与数据边界索引，只做解释和跳转 | `PrivacySettings.tsx`, `SettingsModal.tsx`, `settingsIndex.ts`, Appshots/Channels/MCP/Model 跳转点 | 七块边界可见；所有跳转有效；非 admin 不看到 raw config | PR-1 |
| PR-5 | Voice and transcription boundary | 把聊天语音、voice paste、桌面音频、channel voice 四条路径分开表达 | `useVoiceInput.ts`, `VoiceInputButton.tsx`, `voicePaste.ipc.ts`, `desktop.ipc.ts`, `PrivacySettings.tsx` | 首次/路径变化时能看到本地/云端说明；临时文件清理测试覆盖 | PR-2, PR-4 |
| PR-6 | Token and auth inventory | 把 provider key、channel token、MCP env/header、OAuth、browser relay token 分开展示 | `secureStorage.ts`, `settings.ipc.ts`, `ChannelsSettings.tsx`, `MCPSettings.tsx`, browser relay settings | 普通用户拿不到完整 key；复制完整 token 有明确动作提示；OAuth 只显示状态和 revoke | PR-4 |
| PR-7 | MCP / plugin trust copy | MCP server 和 plugin 详情显示能力范围、auth type、permissions、hooks、外部服务风险 | `MCPSettings.tsx`, `McpServerEditor.tsx`, `PluginsSettings.tsx`, marketplace contract / IPC | destructive/openWorld 工具仍 ask；readOnly 非 openWorld 不新增打扰；secret 不明文展示 | PR-1, PR-6 |
| PR-8 | Channel low-noise state | 渠道内用 typing/progress indicator 保留可感知性，桌面不弹过程通知 | channel adapters, `ChannelManager`, `ChannelsSettings.tsx` | Feishu/Telegram/HTTP API 至少一条通道有低噪状态事件；普通 reply 不触发桌面通知 | PR-3 |

### PR-1 implementation card

任务: Permission boundary contract。

要解决的问题:

- 当前 `PermissionRequest` 已有 `preview`、`dangerLevel`、`decisionTrace`，但缺少统一的数据边界字段。
- `ToolExecutor` 能分类权限和生成预览，却不能稳定告诉 UI “这次会访问哪类数据、存在哪里、是否出云端、如何撤回”。
- `RequestDetails` 能展示 preview 和 decision trace，但还没有专门展示 boundary 摘要。

建议改动范围:

- 新增 `src/shared/contract/permissionBoundary.ts`。
- 从 `src/shared/contract.ts` 和 `src/shared/contract/index.ts` 导出 boundary 类型和 registry helper。
- 在 `src/shared/contract/permission.ts` 的 `PermissionRequest` 增加可选 `boundary` 字段，字段应引用 registry 里的稳定 id，并允许携带本次工具推断出的 short reason。
- 在 `src/renderer/components/PermissionDialog/types.ts` 同步本地 PermissionRequest 类型。
- 在 `src/main/tools/toolExecutor.ts` 的 `buildPermissionRequest` 或紧邻生成 permission request 的位置，为常见工具类型填入 boundary。
- 在 `src/renderer/components/PermissionDialog/RequestDetails.tsx` 增加一块短摘要展示，不改审批按钮逻辑。

第一版 boundary id 至少覆盖:

- `file.project_read`
- `file.project_write`
- `file.external_read`
- `file.external_write`
- `command.shell`
- `network.web_request`
- `mcp.server_tool`
- `memory.local`
- `desktop.screen_capture`
- `desktop.accessibility`
- `desktop.audio.microphone`
- `desktop.audio.system`
- `provider.api_key`
- `channel.connector`
- `telemetry.diagnostic`

每个 registry entry 必须有:

- `title`: 用户可读标题。
- `trigger`: 什么用户动作或工具调用会触发。
- `dataAccess`: 会读/写什么。
- `storage`: 数据会存到哪里，或“不落盘”。
- `cloud`: 是否会发到外部服务。
- `redaction`: 默认脱敏策略。
- `revoke`: 撤回、关闭或修复入口。

UI 展示规则:

- 权限卡片默认显示 `title`、一行 `trigger`、最多前三条 `dataAccess`。
- `cloud` 为外部服务时必须可见。
- `storage`、`redaction`、`revoke` 可放在展开详情里。
- 不把完整 registry 全量展示在弹窗里。
- 不改变 once/session/always/deny 的审批语义。

验收测试建议:

- 新增 `tests/unit/security/permissionBoundary.test.ts`: 覆盖 registry id 唯一、敏感 boundary 不缺 `cloud` / `redaction` / `revoke`。
- 扩展 `tests/unit/tools/toolExecutor.mcpDirect.test.ts` 或新增 toolExecutor boundary 测试: MCP 动态工具、shell、file write、web request 能带 boundary。
- 新增或扩展 PermissionDialog renderer 测试: 有 boundary 时展示标题、trigger、dataAccess；没有 boundary 时保持旧 UI。
- 跑 `tests/unit/ipc/settingsAccess.ipc.test.ts`，确认非 admin settings sanitization 没被 boundary contract 破坏。

不做:

- 不在 PR-1 里改 PrivacySettings 索引页，那是 PR-4。
- 不在 PR-1 里改 notification policy，那是 PR-3。
- 不在 PR-1 里处理 voice transcript log 和 channel error short summary，那是 PR-2。
- 不新增任何会降低审批门槛的自动 allow 逻辑。

### PR-2 implementation card

任务: Sensitive output boundary。

要解决的问题:

- `ChannelAgentBridge` 和 `ChannelManager` 当前多处把 `error.message` 作为外部通道错误回复来源，容易把内部栈、路径、token 片段带到 Feishu/Telegram/HTTP channel。
- `voicePaste.ipc.ts` 当前会 `console.log('[VoicePaste] Pasted:', cleanText.substring(0, 50) + '...')`，会把语音转写正文片段写入日志。
- `speech.ipc.ts` / `voicePaste.ipc.ts` 都涉及云端或本地转写，日志边界应该只保留 provider、duration、size、字符数、错误码，不保留正文。
- notification body 目前会直接使用 summary，后面 PR-3 需要复用同一套 scrub 规则。

建议改动范围:

- 新增 `src/main/security/userFacingError.ts` 或同等模块，提供 `summarizeUserFacingError(error, context)`。
- 复用 `sensitiveDataGuard` / `sensitiveDetector`，不要再新造一套 secret 正则。
- `ChannelAgentBridge`、`ChannelManager.sendErrorResponse`、streaming error 回复统一走 user-facing summary。
- `voicePaste.ipc.ts` 删除转写正文片段日志，改为 transcript length、empty flag、provider、duration。
- `speech.ipc.ts` 对 Groq transcription 成功/失败日志只记 metadata，不记录正文。
- 为 notification body 暴露一个可复用 scrub helper，供 PR-3 接入。

用户可见错误边界:

- channel reply: 短摘要 + retry hint，不带 stack trace、tool args、raw prompt、token、完整本地路径。
- desktop notification: 更短，只保留任务失败/需要介入和下一步，不带 trace。
- local dev trace: 可以保留完整上下文，但默认本地查看，导出/上传前必须 scrub。
- diagnostic bundle: 保留排障结构，走 `sanitizeDiagnosticBundle`。

验收测试建议:

- 新增 `tests/unit/security/userFacingErrorSummary.test.ts`: 输入 `sk-...`、GitHub token、cookie、绝对路径、stack trace，输出不含原始敏感串。
- 新增或扩展 channel 错误测试: `ChannelAgentBridge` / `ChannelManager` 发送到外部 channel 的错误是短摘要。
- 新增 `tests/unit/ipc/voicePastePrivacy.test.ts`: 断言日志不包含 transcript 正文片段。
- 保留并跑 `tests/unit/security/sensitiveDataGuard.test.ts`、`tests/unit/security/sensitiveDetector.test.ts`、`tests/unit/telemetry/diagnosticBundleService.test.ts`。

不做:

- 不改通知准入策略，那是 PR-3。
- 不改设置页隐私信息架构，那是 PR-4。
- 不禁止本地完整 trace。PR-2 的目标是输出面分层，不是让排障失明。

### PR-3 implementation card

任务: Notification policy gate。

要解决的问题:

- `notificationService` 当前入口集中在 `notifyNeedsInput` 和 `notifyTaskComplete`，方向接近 Alma v0.0.820，但没有独立 policy helper 来防止后续新增 progress / typing / tool_started / channel_reply 系统通知。
- `notifyTaskComplete` 会直接把 summary 拼进通知正文，缺少统一 scrub 和长度控制。
- background task、loop、cron、channel adapter 后续都可能各自绕过策略加通知，需要用代码入口挡住。

建议改动范围:

- 新增 `src/main/services/infra/notificationPolicy.ts`。
- 定义 notification intent: `needs_input`, `task_complete`, `task_failed`, `progress`, `typing`, `stream_delta`, `tool_started`, `channel_reply`。
- policy 只允许 `needs_input`、`task_complete`、`task_failed` 进入系统通知。
- `notificationService` 记录和投递前调用 policy，并调用 PR-2 的 scrub helper 处理 title/body。
- 调用点只传 intent，不直接决定是否能出系统通知。
- channel 普通回复、typing/progress indicator 留在 channel 或任务面板，不进入 desktop notification。

策略细节:

- `needs_input`: 权限请求、用户问题、MCP elicitation 可以通知，仍受焦点门控制。
- `task_complete`: 后台任务完成可以 `force` 绕过焦点门，正文必须短。
- `task_failed`: 可以通知，但不能包含 stack trace/token/raw output。
- `progress` / `typing` / `stream_delta` / `tool_started`: 永远不出系统通知。
- `channel_reply`: 默认不出桌面通知；如果未来做 per-channel 完成提醒，必须显式配置，并仍走 scrub。

验收测试建议:

- 新增 `tests/unit/platform/notificationPolicy.test.ts`: 每个 intent 的 allow/block 规则固定。
- 扩展 `tests/unit/platform/notifications.test.ts` 或新增 notification service 测试: dry-run 下 progress 不进 recent notifications，needs_input 和 task_complete 能进入。
- 构造含 token/stack/path 的 failure summary，recent notification 和 delivered payload 都不含敏感串。
- 跑 background task / loop / cron 相关 notification 调用点测试，确认完成通知仍工作。

不做:

- 不复刻 Alma 的浮动通知 UI。
- 不增加过程态系统通知。
- 不在 PR-3 里做 channel typing indicator 的具体实现，那是 PR-8。

### PR-4 implementation card

任务: Boundary settings index。

要解决的问题:

- `PrivacySettings` 当前有“隐私防线”和 Telemetry，但没有把桌面、语音、渠道、MCP/插件、模型 provider、Memory、Telemetry 放进同一张权限与数据边界地图。
- `SettingsModal` 现在能通过搜索切 tab，但隐私页内部没有稳定的边界卡片和跳转。
- `settingsIndex.ts` 搜索还没有覆盖 “语音转写”、“诊断包”、“channel token”、“MCP OAuth”、“browser relay”、“插件权限” 这组入口。

建议改动范围:

- 新增 `src/shared/contract/privacyBoundaryIndex.ts`，只放用户可读的边界索引数据，不放 secret。
- `PrivacySettings.tsx` 渲染七块边界: desktop、voice、channel、mcp/plugin、model provider、memory、telemetry/diagnostic。
- `SettingsModal.tsx` 支持隐私页卡片跳转到已有 tab，例如 appshots、channels、mcp、model、memory、privacy。
- `settingsIndex.ts` 增加边界相关关键词。
- Appshots/Channels/MCP/Model/Memory 原设置页继续承载编辑能力，Privacy 只做解释和跳转。

验收测试建议:

- 新增 `tests/unit/shared/privacyBoundaryIndex.test.ts`: 七块边界都有 title、summary、data、storage、cloud、actionTarget。
- 新增 `tests/renderer/components/privacySettings.boundaryCopy.test.ts`: 隐私页能看到七块边界，且没有完整 key/token/raw config。
- 扩展 `tests/renderer/utils/settingsIndex.test.ts`: 搜索语音转写、诊断包、channel token、MCP OAuth、browser relay、插件权限能命中正确 tab。
- 手工或 renderer 测试确认点击边界卡片能跳到已有设置页。

不做:

- 不把 PrivacySettings 做成第二套编辑页。
- 不在 PR-4 里处理 voice provider 提示，那是 PR-5。
- 不在 PR-4 里展示 MCP env/header 原值或 provider API key。

### PR-5 implementation card

任务: Voice and transcription boundary。

要解决的问题:

- 聊天语音输入通过 `useVoiceInput.ts` 调 `ipcService.transcribeSpeech`，代码注释和 `speech.ipc.ts` 指向 Groq Whisper 云端转写，但用户点击前不清楚。
- `voicePaste.ipc.ts` 先走本地 `whisper-cpp`，失败后回落 Groq，还会用智谱/Kimi 做后处理，边界比聊天语音更复杂。
- `desktop.ipc.ts` / Native Desktop 音频状态已有 `asrEngine`，但设置页显示和隐私边界没有统一。
- channel voice transcription 要和桌面 Whisper setting 分开表达，借鉴 Alma v0.0.820 的边界拆分。

建议改动范围:

- 新增 `src/shared/contract/voiceTranscription.ts`，定义 `chat_voice`, `voice_paste`, `desktop_audio`, `channel_audio` 四条路径。
- 每条路径声明 provider、local/cloud、temporary storage、post-processing、log policy、cleanup policy。
- `VoiceInputButton.tsx` 或相关 chat input 入口在录音前显示短说明: 会请求麦克风、音频会走哪个转写路径。
- `PrivacySettings.tsx` 复用 voice contract，展示四条路径的差异。
- `NativeDesktopSection.tsx` 把 `whisper-cpp` / `qwen3-asr` / `none` 转成用户可读标签。
- `voicePaste.ipc.ts` 与 PR-2 保持一致，不写正文日志。

验收测试建议:

- 新增 `tests/unit/shared/voiceTranscription.test.ts`: 四条路径都声明 provider、cloud、temp storage、cleanup、log policy。
- 新增 `tests/renderer/components/voiceInputButton.privacy.test.tsx`: 录音按钮 title/aria 能说明麦克风和当前转写路径。
- 新增或扩展 `tests/renderer/components/privacySettings.boundaryCopy.test.ts`: 隐私页展示四条语音路径。
- 新增 `tests/unit/ipc/voicePastePrivacy.test.ts`: 成功/失败路径都不 log transcript 内容。

不做:

- 不在 PR-5 里强制改默认 provider。
- 不阻止本地 whisper-cpp fallback。
- 不把 channel voice 配置并入桌面 Whisper setting。

### PR-6 implementation card

任务: Token and auth inventory。

要解决的问题:

- provider API key、channel token/appSecret、MCP env/header、MCP OAuth、browser relay token 分散在不同设置页，用户很难判断每类凭证存在哪里、能否撤回。
- `settings.ipc.ts` 已经对非 admin settings 做 sanitization，但用户侧缺一张不展示 secret 的授权库存。
- `ChannelsSettings` 现在会显示 HTTP API key 前 8 位并可复制完整 key，动作可以保留，但提示要明确。
- `McpServerEditor` env/header JSON 模式存在 raw secret 可见风险，需要有输入态说明和 mask 规则。

建议改动范围:

- 新增 `src/shared/contract/authInventory.ts`，定义 provider key、channel token、MCP env、MCP header、MCP OAuth、browser relay token 六类。
- `PrivacySettings.tsx` 展示授权库存摘要: 来源、存储、展示策略、撤回入口、诊断边界。
- `ChannelsSettings.tsx` 的复制完整 HTTP API key 动作加明确提示，channel token/appSecret/botToken 默认 password input。
- `MCPSettings.tsx` / `McpServerEditor.tsx` 对 env/header 中疑似 secret 的 key 默认 masked；JSON 模式显示原始内容时给明确提示。
- Browser relay 描述要说清 debugger、tabs、activeTab、host permissions、token 连接保护。

验收测试建议:

- 新增 `tests/unit/shared/authInventory.test.ts`: 六类 auth item 都有 storage、display、revoke、diagnostic policy。
- 扩展 `tests/unit/ipc/settingsAccess.ipc.test.ts`: 非 admin 仍拿不到完整 provider key、MCP raw config、security policy。
- 扩展 `tests/renderer/components/channelsSettings.management.test.ts`: channel privacy/token copy 文案可读。
- 扩展 `tests/renderer/components/mcpSettings.status.test.ts`: OAuth 失效显示 reauthorize，不展示 token。

不做:

- 不移除管理员复制完整 token 的能力。
- 不改变 secure storage/keychain 的现有存储策略。
- 不把 OAuth token 原值展示到 UI。

### PR-7 implementation card

任务: MCP / plugin trust copy。

要解决的问题:

- MCP server 详情现在更偏连接状态、tools/resources 数量和重连，用户不容易知道 auth type、transport、openWorld/destructive 工具风险。
- Marketplace/plugin UI 需要展示 skills、commands、permissions、hooks、外部服务风险；未知字段不能被理解为无风险。
- MCP annotations 不完全可信，文案和权限逻辑要保留默认 ask/network 兜底。

建议改动范围:

- `MCPSettings.tsx` 增加 server trust summary: transport、tools/resources count、auth type、permission mapping、reauthorize/revoke。
- `McpServerEditor.tsx` 配合 PR-6 的 env/header masking。
- `PluginsSettings.tsx` 增加 plugin trust summary: skills、commands、permissions、hooks、external services；未声明显示“未声明”。
- marketplace contract / IPC 传递 `commands`、`permissions`、`hooks` 等 manifest 字段。
- MCP tool permission 文案引用 PR-1 boundary id，destructive/openWorld 工具调用前显示风险摘要。

验收测试建议:

- 扩展 `tests/renderer/components/mcpSettings.status.test.ts`: 表格能显示 auth/boundary summary，invalid bearer token 仍显示 reauthorize。
- 扩展 `tests/renderer/components/pluginsSettings.test.ts`: installed/catalog plugin 都展示 trust summary，未声明字段不是空白。
- 扩展 `tests/unit/skills/marketplace/installService.test.ts`: install record 保留 commands/permissions/hooks。
- 跑 `tests/unit/mcp/mcpToolRegistry.test.ts`，确认 readOnly/destructive/openWorld permission metadata 不回退。

不做:

- 不因为 annotations 声称 readOnly 就完全信任 openWorld 工具。
- 不展示 env/header/token 原值。
- 不在 PR-7 里改插件安装权限模型，只改可见 trust copy 和 manifest 传递。

### PR-8 implementation card

任务: Channel low-noise state。

要解决的问题:

- Alma v0.0.820 的关键启发是 channel 内用 typing indicator 保留任务可感知性，同时减少 progress spam，并且 channel conversation 不触发 desktop reply notification。
- Neo 的 Telegram 已有 typing timer；Feishu 有卡片/消息能力，但当前低噪状态策略没有统一表达。
- HTTP API streaming 路径和普通 reply 路径需要和 PR-3 的 notification policy 对齐，不能让普通 channel reply 变成桌面通知。

建议改动范围:

- 在 channel abstraction 或 adapter 层定义 low-noise state 能力: typing、processing、completed、failed。
- Telegram 复用现有 typing timer，补测试和设置说明。
- Feishu 优先用 typing/progress 低噪表达；如果 API 能力不支持，就不要用重复文本刷屏替代。
- HTTP API streaming 路径通过 stream event 表达 processing，不进桌面通知。
- `ChannelsSettings.tsx` 增加默认低打扰策略说明，并为未来 per-channel completion reminder 留配置位置。
- `ChannelManager` / `ChannelAgentBridge` 普通 reply 不调用 desktop notification。

验收测试建议:

- 扩展 `tests/channels/channelMessageReply.test.ts`: 普通 channel reply 不触发 desktop notification mock。
- 新增 channel adapter 单测: Telegram typing starts/stops around response callback；Feishu 不发送重复 progress message。
- 扩展 `tests/renderer/components/channelsSettings.management.test.ts`: 显示低打扰策略文案。
- 跑 PR-3 的 notification policy tests，确认 `channel_reply` 默认 blocked。

不做:

- 不把 progress 文本反复发到群里。
- 不默认打开 channel 完成桌面提醒。
- 不在 PR-8 里改敏感错误摘要，那是 PR-2。

### PR 验收命令

每个实现 PR 至少跑:

- `npx vitest run <changed-area-tests>`
- `npm run typecheck`
- `git diff --check`

P0 完整收口时再跑:

- `npx vitest run tests/unit/tools/permissionClassifier.test.ts tests/unit/permissions/guardFabric.test.ts tests/unit/cli/permissionPolicy.test.ts tests/unit/channels/channelPrivacyFirewall.test.ts tests/unit/channels/feishuPrivacy.test.ts tests/unit/channels/feishuChannelPrivacySmoke.test.ts tests/unit/security/sensitiveDataGuard.test.ts tests/unit/security/sensitiveDetector.test.ts tests/unit/telemetry/diagnosticBundleService.test.ts tests/unit/telemetry/telemetryUploaderService.test.ts tests/unit/telemetry/telemetryRawPayloads.test.ts tests/unit/mcp/mcpToolRegistry.test.ts tests/unit/mcp/logCollector.redaction.test.ts tests/unit/ipc/settingsAccess.ipc.test.ts tests/renderer/components/channelsSettings.management.test.ts tests/renderer/components/mcpSettings.status.test.ts tests/renderer/utils/settingsIndex.test.ts tests/channels/channelMessageReply.test.ts`
- `npx vitest run tests/unit/telemetry/diagnosticBundleService.test.ts tests/unit/telemetry/telemetryRawPayloads.test.ts --pool=forks --maxWorkers=1`

### 最终实现验收矩阵

这张表是后续实现阶段的 review gate。每个 PR 可以小，但不能绕开这些验收项；否则会把“权限更强但解释更弱”的问题继续留在产品里。

| 原始要求 | 实现落点 | 必须证明的证据 | 阻断条件 |
|---|---|---|---|
| 权限请求在用户动作发生时解释清楚，不提前吓人 | PR-1、PR-4、PR-5 | 录音、Appshots、MCP add server、channel connect、provider key 保存只在触发动作时出现边界说明；弹窗展示动作、数据、持续时间和撤回入口 | 设置页一次性塞满系统权限清单；权限弹窗只有 raw tool name 或 enum |
| 敏感信息默认脱敏，但保留开发诊断入口 | PR-2、PR-6 | channel reply、notification、telemetry、diagnostic bundle、hook log、MCP log 都有 scrub 测试；dev trace 只在本机/管理员诊断入口展示，导出或上传前脱敏 | 为了防泄露直接移除完整 trace，或为了排障把 token/stack/raw prompt 暴露给用户表面 |
| 通知只在需要用户介入或任务完成时出现，避免 progress spam | PR-3、PR-8 | notification policy 覆盖全部 intent；progress、typing、stream_delta、tool_started、ordinary channel reply 都不能进入系统通知；needs_input/task_complete/task_failed 能正常通知且正文脱敏 | 新增任何绕过 policy 的桌面通知入口；channel progress 用重复消息刷屏 |
| 渠道、桌面、插件、MCP 的权限边界分开表达 | PR-1、PR-4、PR-7、PR-8 | Privacy 边界索引展示 desktop、voice、channel、MCP/plugin、model provider、memory、telemetry；MCP/plugin 详情展示 transport、auth、permissions、hooks、外部服务风险 | 用一个“外部工具权限”文案覆盖 MCP、plugin、desktop、channel；未知 manifest 字段被当成无风险 |
| 错误短摘要和完整 trace 分边界 | PR-2、PR-3 | 含 stack trace、token、cookie、本地路径的错误在 channel reply 和 desktop notification 中只剩短摘要；完整 trace 进本地日志或诊断包并 scrub | `error.message` 直接发到 Feishu/Telegram/HTTP channel；失败通知包含 stack trace |
| API key、OAuth、channel token、transcription、memory 的存储和展示策略清楚 | PR-4、PR-5、PR-6 | provider key 仍走 secure storage/keychain；OAuth 只显示 connected/revoke/reauthorize；channel token 默认 password/masked；转写路径声明本地/云端、临时文件、日志策略；memory 说明本地存储和脱敏边界 | 非 admin IPC/UI 能读到完整 key 或 raw MCP config；复制完整 token 没有显式动作提示 |
| Alma 证据和推断分开 | 研究文档和实现 PR 描述 | PR 描述引用本研究里的 `证实` / `推断`，新发现必须补证据，不把猜测写成竞品事实 | 用 release note 推断替代本地代码或 UI 复核；把缺失旧/新 bundle diff 的部分写成确定事实 |
| 不做 onboarding 对标 | 所有 PR | PR diff 不新增 onboarding 流程、引导页或首启教程 | 借权限解释之名改 onboarding |

实现阶段的关闭条件:

- PR-0 到 PR-3 关闭后，必须能证明 P0 风险已经被收住: 权限有统一 boundary、敏感输出默认短摘要/脱敏、系统通知有 policy gate。
- PR-4 到 PR-8 关闭后，必须能证明 P1 产品表达已经补齐: 设置页能让用户按桌面、语音、渠道、MCP/插件、provider、Memory、Telemetry 查到边界和撤回入口。
- 全部关闭前不要把这条线标成“实现完成”。只完成研究文档时，状态应写成“研究和方案完成，产品实现未开始”。

### 不混进这些 PR

- 不做 onboarding 对标和 onboarding UI。
- 不做 Alma 浮动通知 UI 复刻。
- 不削弱现有 permission classifier、GuardFabric、Seatbelt。
- 不把 PrivacySettings 改成第二套完整设置页。索引页只解释和跳转。
- 不把所有诊断内容完全禁止。策略是默认脱敏、短摘要外显、完整 trace 本地可查、上传前 scrub。

## 设计建议

- 权限文案按动作写，不按系统名写。比如“读取当前窗口截图和窗口文本，用于把截图贴进当前会话”，比“需要屏幕录制和辅助功能”更容易理解；系统名放第二行。
- 隐私页用三层结构: 默认本地、会出云端的例外、诊断/导出的例外。不要把所有内容都归到“隐私防线”。
- 通知文案只保留结果和下一步。进度留在任务面板或 channel typing indicator，不进系统通知。
- 错误 UI 一律短摘要优先，完整 trace 折叠在开发诊断入口里，并标注“本机查看/导出前脱敏”。
- 渠道、桌面、插件、MCP 要分开表达授权边界。不要用一个“外部工具权限”盖住所有外部能力。

## 不做的事

- 不做 onboarding 对标。
- 不建议照搬 Alma 的浮动通知 UI。Neo 当前更需要先统一策略。
- 不建议削弱 Neo 现有 permission classifier、GuardFabric、Seatbelt。要补的是用户解释和跨表面一致性。
- 不建议把所有敏感数据都完全禁止进入诊断。更现实的边界是默认脱敏、短摘要外显、完整 trace 本地可查、上传前 scrub。

## 复核清单

Alma:

- `/Applications/Alma.app/Contents/Info.plist`: 0.0.823、麦克风/日历/相机/Bluetooth usage descriptions。
- `/Applications/Alma.app` entitlements: audio input、Apple Events automation。
- `/Applications/Alma.app/Contents/Resources/app.asar`: `permissions:request`, `request-microphone-permission`, `mcp-oauth-start`, `alma-notification:public-notify`, ACP permission handler。
- `/Applications/Alma.app/Contents/Resources/app.asar`: SpeechInput 麦克风申请、Whisper 初始化/转写、MCP server/tool selector。
- `/Applications/Alma.app/Contents/Resources/chrome-extension/manifest.json`: debugger/tabs/activeTab/storage/alarms 和 `<all_urls>`。
- `/Applications/Alma.app/Contents/Resources/bundled-skills/computer-use/SKILL.md`: AX/Screen Recording permission gate、`ax_not_granted`、`sc_not_granted`。
- `/Applications/Alma.app/Contents/Resources/bundled-skills/voice/SKILL.md`: local Qwen3-TTS，无 API key、无网络。
- GitHub release notes v0.0.807、v0.0.813、v0.0.820、v0.0.823。

Neo/code-agent:

- `src/main/tools/permissionClassifier.ts`
- `src/main/permissions/modes.ts`
- `src/main/permissions/policyEngine.ts`
- `src/main/permissions/guardFabric.ts`
- `src/main/permissions/hookSource.ts`
- `src/main/sandbox/seatbelt.ts`
- `src/shared/contract/permission.ts`
- `src/main/security/sensitiveDataGuard.ts`
- `src/main/security/sensitiveDetector.ts`
- `src/main/channels/privacy/channelPrivacyFirewall.ts`
- `src/main/services/core/secureStorage.ts`
- `src/main/ipc/settings.ipc.ts`
- `src/main/telemetry/telemetryUploaderService.ts`
- `src/main/telemetry/diagnosticBundleService.ts`
- `src/shared/observability/scrubEvent.ts`
- `src/main/hooks/hookManager.ts`
- `src/main/hooks/scriptExecutor.ts`
- `src/main/mcp/mcpToolRegistry.ts`
- `src/main/tools/modules/mcp/mcpAddServer.ts`
- `src/main/services/infra/notificationService.ts`
- `src/main/session/backgroundTaskManager.ts`
- `src/main/tasks/backgroundTaskLedger.ts`
- `src/renderer/components/features/settings/tabs/PrivacySettings.tsx`
- `src/renderer/components/features/settings/tabs/ChannelsSettings.tsx`
- `src/renderer/components/features/settings/tabs/MCPSettings.tsx`
- `src/renderer/components/features/settings/tabs/AppshotsSettings.tsx`
- `src/renderer/components/features/settings/sections/NativeConnectorsSection.tsx`
- `src/renderer/hooks/useVoiceInput.ts`
- `src/main/ipc/voicePaste.ipc.ts`
- `src/main/ipc/desktop.ipc.ts`

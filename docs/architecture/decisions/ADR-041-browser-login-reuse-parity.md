# ADR-041 — 浏览器登录态复用双通道与 `browser_action` 双引擎对标

- Status: accepted（产品已拍板双通道完整对标 Alma 0.0.876，不以最小能力清单替代）
- Date: 2026-07-16
- Related: `src/host/services/infra/browserService.ts`、`src/host/services/infra/browserRelayService.ts`、`resources/browser-relay-extension`、`src/renderer/components/features/browser/BrowserSurfacePanel.tsx`、`src/host/tools/vision/browserAction.ts`、`src/shared/contract/desktop.ts`、`docs/architecture/workbench.md`、`docs/ARCHITECTURE.md`

## Context

Neo 要让 Agent 在两类互补场景中复用浏览器登录态：一类是继续使用 Neo 隔离管理、适合自动化与测试的浏览器；另一类是驱动用户已经登录且明确授权附着的真实 Chrome 标签页。Alma 0.0.876 已通过两条产品通道覆盖这两个场景：

1. **Profile Cookie 导入**：从本机 Chromium 系浏览器 profile 读取 Cookie，导入隔离浏览器。
2. **Chrome Relay**：通过扩展、local host 和 Agent 动作层附着并驱动真实标签页。

两条通道解决的问题不同。Cookie 导入把一份受控登录态快照复制进 Managed browser；Relay 使用用户真实浏览器中的当前登录态。完整对标要求两条通道同时成为产品能力，并在同一个 Agent 浏览器动作契约下工作。

### Neo as-built

- Managed browser 实现在 `src/host/services/infra/browserService.ts`，provider 为 `system-chrome-cdp` 或 `playwright-bundled`。persistent profile 的固定标识为 `managed-browser-profile`，由 `src/host/services/infra/browser/managedBrowserHelpers.ts` 解析到 Neo 自己的 user data 目录；isolated mode 使用可清理临时 profile。
- `browserService.ts` 已提供 `exportStorageState` / `importStorageState`，对外动作为 `export_storage_state` / `import_storage_state`。它们读写 Playwright `storageState` 文件；`importStorageState` 会把文件中的 Cookie 交给 `BrowserContext.addCookies`，同时恢复文件里的 origin storage。这条能力属于 CI/脚本文件交换，当前不负责发现或解密本机 Chrome profile Cookie。
- Relay host 骨架位于 `src/host/services/infra/browserRelayService.ts`：默认监听 `127.0.0.1:23001`，WebSocket 使用 token 鉴权，并通过替换已有 socket 保持单连接。当前 host 直接封装的能力只有 tab 列表、创建与导航。
- 扩展位于 `resources/browser-relay-extension`。当前协议 methods 为 `tabs.list`、`tabs.create`、`tabs.navigate`、`tabs.screenshot`、`debugger.attach`、`debugger.detach`、`cdp.send`；扩展可以附着真实 Chrome 标签页，但 popup 目前只显示连接状态、端口和已附着数量。
- Browser Surface UI 位于 `src/renderer/components/features/browser/BrowserSurfacePanel.tsx`，当前提供 Relay 启停、复制 token 和打开扩展目录；尚无安装向导、tab 列表或从 UI 附着当前标签页的完整流程。
- Desktop IPC 已有 `startBrowserRelay`、`stopBrowserRelay`、`getBrowserRelayState`、`listBrowserRelayTabs`、`openBrowserRelayTab`、`openBrowserRelayExtensionDirectory`。
- Relay 状态 contract 为 `src/shared/contract/desktop.ts` 中的 `ManagedBrowserExternalBridgeState`，包括 status、显式授权标志、port、token hint、extension path、连接与附着数量等字段。
- `browser_action` 实现在 `src/host/tools/vision/browserAction.ts`，当前全部动作直接调用 agent-scoped `BrowserService`。Relay 尚未成为 Agent 可选执行引擎。
- `docs/architecture/workbench.md` 与 `docs/ARCHITECTURE.md` 曾把 external Chrome profile、external CDP attach 和 extension bridge 列为 backlog。本 ADR 以 accepted 决策关闭该产品 backlog；实现完成度继续由本 ADR 的里程碑和验收证据判定。

### Alma 0.0.876 对标基线

- Alma iab Cookie 导入有钥匙入口 UI 和 `alma iab profiles` 命令。它从 macOS Keychain 读取对应浏览器的 `* Safe Storage`，使用 `pbkdf2(password, "saltysalt", 1003, 16, sha1)` 派生密钥；读取前把 `Cookies` DB 及存在的 `-wal` / `-shm` 复制到临时位置，并以只读方式查询快照。
- 其 profile catalog 覆盖 `chrome`、`chrome-beta`、`chrome-canary`、`chromium`、`edge`、`brave`、`arc`、`vivaldi`。
- Alma Chrome Relay 通过扩展附着真实标签页，并在 CLI/Agent 一侧提供高阶浏览动作，而非只暴露原始 CDP 命令。
- Alma 的方案不挂载用户日常 `user-data-dir`。本 ADR 延续这一隔离边界。

## Decision

1. **Managed 与 Relay 成为一等浏览器引擎。**
   - `Managed engine` 指 Neo 隔离管理的自动化上下文，执行 provider 为 `system-chrome-cdp` 或 `playwright-bundled`。
   - `Relay engine` 指扩展明确附着的真实 Chrome 标签页，执行 provider 为 `browser-relay`。
   - `browser_action` 增加可选参数 `engine?: 'auto' | 'managed' | 'relay'`，缺省值为 `auto`。现有未传 `engine` 的调用保持兼容。
   - 两个引擎共享一个 `browser_action` 动作目录、风险语义、结果 envelope、proof 与 recovery contract。能力差异必须通过结构化 capability/result 表达，不能由 prompt 猜测。

2. **Profile Cookie Import 成为面向用户的产品通道。**
   - 新增本机 browser/profile 发现、Cookie domain 预览、导入确认、执行结果与恢复引导的 UI/IPC 流程。
   - `import_storage_state` 保留为 CI、测试和脚本使用的 Playwright 文件通道，不承担本机 profile 发现或 Keychain 解密。
   - `Profile Cookie Import` 与 `import_storage_state` 在解析完成后共享 `BrowserContext.addCookies` 写入底层；两条入口各自保留来源、授权和审计语义。

3. **禁止挂载用户日常 Chrome `user-data-dir`。**
   - Neo 不得用 `--user-data-dir` 指向用户正在使用的 Chrome、Edge、Brave、Arc、Vivaldi 或 Chromium profile。
   - Profile Cookie Import 只把选定 Cookie 写入 Neo 的 managed persistent profile；源 profile 始终作为只读输入。
   - 实现不得通过复制整个 user data directory、复用 singleton lock、绕过浏览器加密或启动用户 profile 的方式规避本决策。

4. **Cookie 导入先交付 macOS，并对齐 Alma 的 Chromium 系源表。**
   - 首批 source id 至少覆盖 `chrome`、`chrome-beta`、`chrome-canary`、`chromium`、`edge`、`brave`、`arc`、`vivaldi`；catalog 负责把 source id 映射到安装、profile、Cookies DB 与 Keychain `* Safe Storage` 服务名。
   - macOS 解密流程按 `pbkdf2(password, "saltysalt", 1003, 16, sha1)` 派生密钥，并兼容受支持 Chromium Cookie schema 的版本标记与字段差异。
   - 读取 `Cookies` 前必须复制 DB 及存在的 `-wal` / `-shm`，从一致的临时快照只读查询，不直接查询活跃源库。
   - Keychain 拒绝、密钥获取失败、schema 不受支持、快照复制不一致或任一 Cookie 解密失败时 fail-closed。产品给出结构化失败原因，并引导用户改用 Relay；禁止把密文、空值或猜测出的明文写入 managed profile。

5. **P1 推荐按 domain allowlist 导入。**
   - 导入 UI 先展示去敏后的 domain 与 Cookie 数量，推荐用户只选择本次任务需要的 domain allowlist。
   - 全 profile 导入可以作为显式高级选择保留，但必须二次确认其范围。allowlist 过滤发生在写入 managed profile 之前。
   - domain 匹配规则、子域处理和被跳过数量必须可测试、可解释；UI、日志和 proof 只展示 domain/计数，不展示 Cookie value。

6. **授权、临时文件与敏感数据采用 fail-closed 安全边界。**
   - 每次 Profile Cookie Import 都要求用户显式确认 source profile、目标 managed profile 与 domain 范围。后台任务或 Agent 不得静默发起导入。
   - 一次导入操作最多触发一次 Keychain 授权流程；取得的 key material 只保留在该操作的内存生命周期中，不持久化。
   - 临时 DB、`-wal`、`-shm` 及派生中间文件权限必须为 `0600`，并在 `finally` 中删除。成功、失败、取消和进程内异常路径都要覆盖清理测试。
   - application log、tool log、telemetry、`BrowserComputerProof`、agent pointer metadata、session export、diagnostic bundle 与 crash context 永不写入 Cookie value、解密 key、Relay auth token 或 storage token。任何无法证明已去敏的错误对象不得透传。

7. **Relay 从传输骨架升级为完整产品引擎。**
   - host 新建 `relayActionFacade`，在现有 `cdp.send` 之上实现与 Managed engine 对齐的高阶动作，至少包含 `click`、`type`、`read/get_content`、`dom`、`a11y`、`scroll`、`back`、`forward`、`navigate`、`screenshot` 与 tab 管理。
   - facade 负责 target 定位、坐标/DOM 证据、超时、错误归一化和结果 redaction；Agent 不直接拼装任意 CDP 调用作为产品主路径。
   - 扩展 popup 提供一等的“附着当前标签”与解除附着动作，并清楚显示当前 tab、连接状态和授权状态。附着仍由用户显式动作触发。
   - Browser Surface 提供扩展加载/连接向导、token 配置状态、可用 tab 列表、附着状态与打开/切换 tab 的产品流程。
   - `browser_action(engine: 'relay')` 可驱动已附着标签，并使用与 Managed engine 相同的 action 名与返回语义。

8. **`browserEngineRouter` 以登录态、附着状态和运行环境执行确定性 Auto 路由。**
   - 用户显式传入 `managed` 或 `relay` 时，router 尊重选择；目标引擎不可用时返回 recovery，不静默改走另一引擎。
   - `auto` 在存在已附着且适合目标 URL 的真实标签页，或任务明确需要现有登录态时，倾向 `relay`。
   - `auto` 在 `localhost`、workspace preview、隔离运行、CI、测试或要求可重建 profile 的场景中选择 `managed`。
   - router 的判断只能使用已去敏的状态摘要、目标 URL 分类、显式执行意图和 capability，不读取或记录 Cookie value。
   - 路由失败返回结构化 recovery，至少包含 `code`、`requestedEngine`、`selectedEngine`、`recoverable`、`recommendedAction`、`availableEngines`。典型恢复动作包括启动 Managed browser、启动 Relay、安装/连接扩展、附着标签、重新选择 tab 或改用 Cookie 导入。

9. **两条通道接入现有浏览器证据链。**
   - Managed、Relay 和 Profile Cookie Import 动作都进入现有 `BrowserComputerProof` ledger，并产生可关联的 agent pointer/trace 证据；import 无页面坐标时记录操作级 pointer，不伪造页面交互坐标。
   - 执行 proof 以 `provider` 区分 `system-chrome-cdp`、`playwright-bundled`、`browser-relay`；导入 proof 另以 `importSource` 区分 browser/profile source，并记录选中 domain 数、导入/跳过/失败计数等去敏摘要。
   - proof、pointer、session export 与日志共享同一 redaction policy。Relay token、Cookie value、Cookie encryption material 和页面内识别出的 auth token 均属于禁止落盘字段。
   - 每次结果必须能回答“选择了哪个 engine/provider、操作了哪个安全标识的 tab/profile、为何这样路由、证据存在哪里”，同时不泄露登录凭据。

10. **按职责拆分模块，阻止 `browserService.ts` 继续膨胀。**
    - `browserProfileCatalog`：发现受支持浏览器、profile、Cookies DB 和 Keychain service 映射，不读取 Cookie value。
    - `browserCookieCrypto`：Keychain key material 生命周期、PBKDF2 与 Cookie 解密，只接受临时快照记录并返回最小 Cookie DTO。
    - `browserProfileImportService`：确认后的导入编排、快照复制、`0600`、allowlist、`finally` 清理、`addCookies` 与去敏结果。
    - `relayActionFacade`：Relay 高阶动作与 Managed action contract 的适配层。
    - `browserEngineRouter`：显式 engine 选择、Auto 路由、capability 判断和 recovery。
    - `browserService.ts` 继续拥有 Managed browser 生命周期与 Playwright context；不得吸收 profile catalog、Cookie crypto、Relay facade 或跨引擎路由职责。

11. **accepted 表示产品方向与边界已生效，交付仍按里程碑验收。**
    - 既有规格中“external Chrome profile attach / extension bridge remain backlog”的表述由本 ADR 关闭或改写为 rollout 状态。
    - 在 M0–M5 验收完成前，产品和文档必须准确标注当前可用能力，不能因 ADR 已 accepted 宣称双通道已实现。

## Non-goals

- Firefox 或 Safari profile Cookie 导入。
- 对本机 profile 做完整 `localStorage`、`sessionStorage`、IndexedDB、Service Worker 或 Cache Storage 镜像。
- 远程 browser pool、云端 profile 托管或跨设备同步。
- 与 Alma 的内部协议、扩展协议或 CLI wire format 互通；对标的是用户能力与安全边界。
- 把 Browser 默认改为 On。Managed 启动、Relay 启动/附着和 Cookie 导入仍遵守现有显式入口与授权策略。
- 绕过 MFA、CAPTCHA、支付确认、浏览器安全警告或网站反自动化策略。

## Rollout

里程碑表达依赖关系和验收切片，不构成固定工期承诺：

- **M0 Contract 与安全基线**：定义 `engine`、provider/import source、capability、recovery 与 redaction contract；建立禁止敏感字段落盘的自动化测试。
- **M1 macOS Profile Import 内核**：完成 `browserProfileCatalog`、`browserCookieCrypto`、临时 DB 快照和 fixture/schema 测试。
- **M2 Profile Import 产品流程**：完成 Browser Surface 发现、domain allowlist、显式确认、Keychain 单次授权、导入结果与 Relay recovery。
- **M3 Relay 产品化**：完成 popup 附着当前标签、Surface 向导/tab 列表和 `relayActionFacade` 高阶动作。
- **M4 双引擎路由与 Agent 接线**：`browser_action` 支持三种 `engine` 选择，Relay 进入 proof、pointer、redaction 和结构化 recovery。
- **M5 对标验收与文档收口**：按共同 action matrix 做 Managed/Relay parity、真实 macOS profile 导入 smoke、故障注入、隐私审计和 dogfood；验收通过后更新 backlog 与用户文档的完成状态。

## Acceptance

1. `browser_action` schema 接受 `auto | managed | relay`，显式 engine 不发生静默切换；Auto 路由可用单测证明上述分流规则。
2. macOS catalog 能发现 Alma 基线中的 Chromium 系 source id；受支持 profile 的 DB snapshot、Keychain/PBKDF2 解密、schema 适配和 `addCookies` 写入均有 fixture 测试与至少一次真实机 smoke 证据。
3. 任一导入必须经过 UI 显式确认；domain allowlist 在写入前生效；源 DB 未被修改，临时 DB 文件为 `0600` 且所有终止路径最终删除。
4. 注入 Keychain 拒绝、错误密钥、损坏 DB、WAL 截断/不一致、未知 schema 和单条解密失败时，导入 fail-closed，并返回可操作的 Relay recovery；源 profile 本来没有 `-wal` / `-shm` 时仍可读取主 DB 快照。
5. 扩展 popup 可附着/解除当前标签，Browser Surface 可完成连接向导、列出 tab 和显示附着状态；Agent 能通过 `browser_action(engine: 'relay')` 执行 M3 action matrix。
6. 同一高阶动作在 Managed 与 Relay 返回兼容的 success/error/proof envelope；不支持的能力返回明确 capability error。
7. `BrowserComputerProof`、agent pointer、logs、telemetry、session export 与 diagnostic bundle 能区分 engine/provider/import source；自动化 secret canary 测试证明其中不含 Cookie value、解密 key、Relay token 或页面 auth token。
8. 静态与运行时 guard 证明生产代码从未把用户日常 browser profile 路径传给 Chrome `--user-data-dir`；Managed 只启动 Neo 自有 persistent/isolated profile。
9. 既有 `export_storage_state` / `import_storage_state` CI 和脚本用例保持通过，并能证明两种 import 入口最终共用 `BrowserContext.addCookies` 写入边界。

## Consequences

- 用户可以按任务选择隔离自动化或真实登录态，登录、MFA 后继续操作等场景不再依赖手工重复登录；localhost、测试和可重建任务仍保有稳定隔离环境。
- Cookie Import 是登录态快照，不与源浏览器持续同步。依赖 localStorage、IndexedDB、设备绑定、客户端证书或实时会话挑战的网站可能无法仅靠 Cookie 恢复，应通过结构化 recovery 转到 Relay。
- domain allowlist、只读快照、禁止挂载日常 profile 与全链路 redaction 降低凭据暴露面，但 Keychain、Chromium schema 与不同浏览器路径仍形成持续维护成本。
- Relay 使用 `chrome.debugger` 附着真实标签，用户会看到浏览器的调试提示；tab 选错会作用于真实会话，因此 popup、Surface、proof 和 Agent 结果都必须持续显示目标 tab 的安全标识与附着状态。
- 双引擎共享 action contract 会增加 facade、capability matrix、路由和 parity 测试成本；收益是 Agent、UI、审计和未来动作无需维护两个互不兼容的工具体系。
- `browserService.ts` 的职责边界变窄，新增复杂度分散到可独立测试的 catalog、crypto、import、facade 与 router 模块。

## Rejected alternatives

### 直接用 `--user-data-dir` 挂载用户日常 profile

活跃 Chromium profile 存在 singleton lock、并发写库、扩展副作用、schema 漂移和用户数据损坏风险。该方案还会把 Neo 自动化权限扩大到整个日常 profile，违背隔离、显式授权和最小暴露原则。

### 只做 Relay，取消 Profile Cookie Import

Relay 适合真实登录态与强设备绑定场景，但依赖扩展安装、连接和标签附着，也无法替代 CI、隔离自动化或需要可重建 profile 的任务。缺少 Cookie Import 会让对标只覆盖一半产品场景。

### 只做 Profile Cookie Import，取消 Relay

Cookie 快照无法完整复制 localStorage、IndexedDB、设备绑定、MFA 后挑战和实时浏览器状态。缺少 Relay 时，这些失败只能退回手工操作，也无法让 Agent 驱动用户明确授权的当前标签页。

### 只保留 `storageState` 文件，不提供产品 UI 导入

Playwright 文件要求用户自行导出、管理路径并理解格式，无法发现本机 profile、完成 Keychain 授权、预览 domain 范围或执行安全清理。它继续适合作为 CI/脚本通道，不能承担面向普通用户的登录态复用入口。

### 把 Relay 建成独立 tool 名

独立 tool 会复制动作 schema、prompt、风险策略、proof、UI renderer 和 recovery，并把引擎选择推给模型。统一在 `browser_action.engine` 下可保持一种动作语言，由 `browserEngineRouter` 做可测试、可解释的确定性选择。

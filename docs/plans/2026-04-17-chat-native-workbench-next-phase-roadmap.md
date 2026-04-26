# Chat-Native Workbench 下一阶段完整路线图

日期：2026-04-17  
状态：已按 2026-04-26 productization 实际状态对齐
关联设计：[2026-04-16-chat-native-agent-workbench-plan.md](/Users/linchen/Downloads/ai/code-agent/docs/plans/2026-04-16-chat-native-agent-workbench-plan.md)  
关联实施：[2026-04-16-phase1-chat-native-workbench-implementation-spec.md](/Users/linchen/Downloads/ai/code-agent/docs/plans/2026-04-16-phase1-chat-native-workbench-implementation-spec.md)  
关联分析：[2026-04-16-accio-vs-code-agent-core-differences.md](/Users/linchen/Downloads/ai/code-agent/docs/analysis/2026-04-16-accio-vs-code-agent-core-differences.md)  
补充参考：
- [2026-03-12-historical-session-ux-summary.md](/Users/linchen/Downloads/ai/code-agent/docs/analysis/session-product-optimization/2026-03-12-historical-session-ux-summary.md)
- [2026-03-12-current-session-summary.md](/Users/linchen/Downloads/ai/code-agent/docs/analysis/evaluation-optimization/2026-03-12-current-session-summary.md)

## 1. 结论

按当前代码与测试看，`chat-native workbench` 已经不再处在“Phase 2-6 都还没开始”的状态。

更准确的口径是：

- `Phase 1` 已交付并关账
- `Phase 2` 已交付并关账
- `Phase 3` 已落基础骨架和 native connector 最小产品化管理面，但非 native connector 与统一管理面还没完成，不能整体关账
- `Phase 4` 已有最小显式 browser / desktop session 心智
- `Phase 5` 已有最小 session-native workspace 闭环
- `Phase 6` 已按 `trace identity -> review queue -> failure_followup asset draft -> session-backed reuse / local presets` 的最小闭环关账
- `Live Preview V2-A/B` 已按 Vite-only MVP 收敛：DevServerLauncher + TweakPanel 已交付，Next.js App Router V2-C 按 ADR-012 延期
- `Browser / Computer Workbench` 已从 smoke 级推进到生产化基线：BrowserSession/Profile/AccountState/Artifact/Lease/Proxy/TargetRef 与 browser task benchmark 已落地
- `Semantic Tool UI` 已打通 `_meta.shortDescription` 从 prompt/schema/parser 到 trace UI 的链路，弱模型缺失时走 fallback generator

一句话判断：

`后续 backlog 不该再笼统写成“继续做 Phase 2-6”，而要写成“补齐尚未产品化的 richer backlog 和 4 月 26 日之后还留着的硬边界”。`

## 2. 当前已完成的基础

当前主链路已经具备这些基础能力：

- `ConversationEnvelope`：消息级 workbench 上下文已经打通
- `InlineWorkbenchBar`：workspace / routing / skills / connectors / MCP 已经进入发送链
- `LaunchRequestCard`：swarm launch approval 已回到聊天主链路
- `@agent`：文本 mention、agent chips、routing metadata、trace 回显已经合流
- `toolScope`：skills / connectors / MCP 已进入当前 turn 的硬作用域
- `useWorkbenchCapabilities / useWorkbenchInsights`：共享能力模型、引用模型、历史模型、视图模型已成型
- `WorkbenchPrimitives`：聊天栏、trace、TaskPanel 的基础 workbench 展示原件已开始共享
- `Unified Trace Identity + Review Queue`：Replay / Eval Center / session list 现在共享稳定 trace identity，而不是各找各的最近文件
- `failure_followup sink`：Replay 里的 failure attribution 已能回流到 Review Queue，并生成本地 failure asset draft
- `session-backed reuse / local presets`：历史 session 的 workbench 配置已能回灌到当前 session，命名 preset 与 recipe store 已有本地资产层
- `Live Preview V2-A/B`：本地 dev server lifecycle、iframe source grounding、protocol 0.3.0、TweakPanel 五类原子样式修改已落地
- `Browser/Computer productionization`：managed browser session/profile/account/artifact/lease/proxy、TargetRef/stale recovery、download/upload、browser task benchmark、background AX/CGEvent smoke 已落地
- `Semantic Tool UI`：工具 `_meta.shortDescription` 强制 schema、provider parser、SessionRepository fallback、ToolHeader/MemoryCitation/SessionDiff/URL chip 已接入

这意味着：

`剩下更值钱的，不是再证明“这些能力能不能做”，而是把还没关账的 backlog 说清楚。`

## 3. 优先级总览

### P0：还没关账的 backlog

1. `Connector lifecycle` 的非 native / 统一管理面
2. `Failure-to-Capability` 的 triage、批处理与 asset apply/export
3. 命名 `presets / recipes` 的 UI、搜索、分享、版本化与 recipe 执行编排
4. Live Preview V3：partial HMR、批注/多选、Next.js 支持重新评估

### P1：做得更完整，而不是补第一版

5. remote browser pool / external CDP / external profile / extension bridge 的边界设计
6. 更强的 session search / background / long-session robustness

### P2：后续增强

7. `Multi-agent team productization`
8. 更丰富的 personalization
9. `Performance / virtualization`

### 明确不建议现在做

- 重写 swarm 引擎
- 重做整套 settings 信息架构
- 引入更复杂的 team/channel 数据模型
- 做“插件商城”式大而全 capability marketplace
- 把 Next.js App Router click-to-source 硬塞回 V2
- 在没有独立授权和隔离前接外部 Chrome profile / extension bridge

## 4. 路线图

---

## Phase 2：执行清晰度补齐

### 当前实际状态

已交付并关账。

当前完成定义是：一条 workbench 消息在聊天主链路里，已经能看到 `workbench snapshot / capability scope / routing evidence / artifact ownership` 这 4 层最小解释链，而且 `Direct` routing evidence 在 runtime 事件消失后，还能依靠持久化 metadata 回放。

证据：

- `src/shared/contract/turnTimeline.ts`
- `src/renderer/utils/turnTimelineProjection.ts`
- `src/renderer/stores/turnExecutionStore.ts`
- `src/main/agent/agentOrchestrator.ts`
- `src/renderer/hooks/useAgent.ts`
- `tests/renderer/hooks/useTurnExecutionClarity.test.ts`

### 目标

让用户在聊天主链路里看到：

- 这条消息带了什么上下文
- 实际是谁接手了
- 实际用了哪些能力
- 哪些能力被拒绝/跳过
- 当前执行到了哪一层

### 为什么值钱

当前 workbench 已经能“选”，但还不够“解释”。

如果继续只加入口，不补执行解释层，会出现三个问题：

- 用户感觉自己“选了，但不确定有没有生效”
- routing / toolScope / capability 失败时，反馈太弱
- TaskPanel 和聊天区之间仍然存在理解断层

### 子项

#### 2.1 Turn Workbench Timeline

在当前 turn 内新增轻量时间线，至少投影：

- workbench snapshot
- launch approval / approval result
- routing result
- active agent handoff
- tool scope filtering result
- capability invocation summary
- outputs/artifacts produced

注意：

- 不做全量 debug console
- 只展示“普通用户需要理解执行”的关键节点

#### 2.2 Missing-State Action Cards

当用户选择的 capability 不能立即执行时，不只显示灰态，要给出具体原因和下一步动作：

- skill 未挂载
- connector 未连接
- MCP server 未连通
- browser session 未建立
- desktop permission 未授权

目标形态：

`selected but blocked -> reason + one-step action`

#### 2.3 Routing Evidence

把“Direct / Parallel / Auto”从意图回显推进到执行证据：

- direct：显示实际收到任务的 agent
- parallel：显示 launch 计划和最终启动结果
- auto：显示是否退回单 agent、是否触发 parallel proposal

#### 2.4 Artifact Ownership

把“谁产生了什么输出”投影回 turn：

- 文件
- patch
- external link
- note / plan
- skill output

目标：

用户在聊天里就能知道“这轮工作留下了什么”。

### 成功标准

- 用户不打开 TaskPanel，也能理解一条 workbench 消息的大部分执行过程
- blocked capability 不再只显示为灰态，而是能直接解释原因
- routing 结果不再只是 metadata，而有执行证据
- turn 下方能看到最关键的 outputs

### 建议落点

- `TraceNodeRenderer`
- `useTurnProjection`
- `useWorkbenchInsights`
- `TaskMonitor` 与聊天 trace 的投影契约

---

## Phase 3：统一能力生命周期

### 当前实际状态

已落 native connector 最小产品化闭环和设置页 lifecycle 管理入口；非 native connector 和更完整的统一管理面仍是 backlog。

当前已落：

- `capability registry` / lifecycle 字段 / unified sheet 已有
- `skill mount` 与 `MCP retry` 有最短路径 quick action
- selected capability 会展示真实 blocked reason / hint
- `NativeConnectorsSection` 已能展示 native connector status/readiness/actions，并直接触发检查、修复权限、断开、移除

当前仍未落：

- 没有跨 skill / connector / MCP 的统一“发现 -> 安装 / 连接 / 挂载 -> 修复 -> 授权 -> 移除 / 断开”产品路径
- 还不能把 Phase 3 写成“任一 capability 都能从不可用走到可用于当前 turn”

当前产品口径必须明确：

`connector lifecycle` 已覆盖 native connector 的启用、显式检查、权限修复、断开、移除、设置页 lifecycle 入口和 toolScope gate；还没有覆盖非 native connector，也没有做完整统一连接器管理面。

### 2026-04-24 connector lifecycle 最小产品化补齐

这轮只补 native connector 的 lifecycle 主路径，不重做 AbilityMenu 或 Settings IA。

已落：

- `connector.retry` 对已知 native connector 不再停在 `Unknown connector`，而是写入 `connectors.enabledNative`、重新 configure registry，并广播最新 status
- enabled native connector 默认进入 `待检查` / `connector_unverified`，不再因为 macOS 平台存在就直接显示 connected
- `检查/授权` 会触发真实 AppleScript probe，成功后标记 ready，失败后标记 `connector_auth_failed` 并保留错误信息
- connector quick actions 拆成 `启用/重试`、`检查/授权`、`打开本地应用`、`打开连接器设置`
- native connector status 增加 `repair_permissions` / `disconnect` / `remove` lifecycle actions
- IPC 增加 `repairPermission` / `disconnect` / `remove`，会同步 `connectors.enabledNative`、registry 和状态 broadcast
- 断开/移除后会从当前 composer 选择里移掉 connector，避免 stale selection 继续进入下一轮
- `打开连接器设置` 复用现有 MCP settings tab 里的 `NativeConnectorsSection`
- `NativeConnectorsSection` 已从 `listNativeInventory + listStatuses` 合并 readiness/actions，并提供 `检查 / 修复权限 / 断开 / 移除` 按钮
- 单测覆盖 retry enable helper、disconnect/remove 设置更新、connector quick action routing、sheet 文案和 registry blocked 映射

仍不宣称完成：

- 不在启动时自动拉起 Mail / Calendar / Reminders
- probe 状态是当前运行期的最小 UI 状态，不是完整长期授权资产
- 非 native connector、完整权限修复向导、跨 connector 的统一管理面仍是后续 backlog

证据：

- `src/renderer/utils/workbenchCapabilityRegistry.ts`
- `src/renderer/utils/workbenchQuickActions.ts`
- `src/main/ipc/connector.ipc.ts`
- `src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner.ts`
- `src/renderer/components/features/settings/sections/NativeConnectorsSection.tsx`
- `tests/unit/ipc/connector.ipc.test.ts`
- `tests/renderer/components/nativeConnectorsSection.test.ts`
- `tests/renderer/utils/workbenchQuickActions.test.ts`
- `src/renderer/components/workbench/WorkbenchCapabilitySheetLite.tsx`
- `tests/unit/connectors/nativeConnectorStatus.test.ts`
- `tests/renderer/utils/workbenchCapabilityRegistry.test.ts`
- `tests/renderer/components/workbenchCapabilitySheetLite.test.ts`

### 目标

把 `skills / connectors / MCP` 从“可选项”升级为“完整生命周期对象”。

### 为什么值钱

当前已经统一了：

- 状态
- 选择
- 作用域
- 历史

但还没有统一：

- 发现
- 安装 / 连接 / 挂载
- 修复
- 授权
- 移除 / 断开

这会让 workbench 永远停在“半产品化”。

### 子项

#### 3.1 Capability Registry

新增统一的 capability registry view model，覆盖：

- `kind`: skill / connector / mcp
- `id / label / description`
- `status`
- `installState / connectionState / mountState`
- `requiredPermissions`
- `availableActions`
- `health`

它不是替换现有 store，而是作为 UI 层唯一主模型。

#### 3.2 Inline Quick Actions

让 `InlineWorkbenchBar` 不只是选择器，还能对未就绪能力做最小动作：

- `Connect`
- `Mount`
- `Retry`
- `Authorize`
- `Open settings`

这里要坚持一个原则：

`快速动作只解决“把当前消息发出去”最短路径，不做大管理面板。`

#### 3.3 Unified Capability Sheet

给 capability 增加统一 detail sheet，内容包括：

- 描述
- 当前状态
- 依赖关系
- 最近调用
- 授权/权限
- 故障原因
- 快捷动作

这层可以被：

- workbench bar
- TaskPanel
- settings

共同复用。

#### 3.4 Scope Inspector

把本次 turn 实际可用的 capability scope 显式展示出来：

- 本轮 user selected
- 本轮 runtime allowed
- 本轮 runtime blocked
- 本轮 actually invoked

这是“选择”和“执行”之间最重要的一层桥。

### 成功标准

- 任一 capability 都能从“不可用”走到“可用于当前 turn”
- 聊天栏、TaskPanel、settings 不再各自维护不同 capability 解释
- 用户能看清“选了但没用上”到底是为什么

### 建议落点

- `useWorkbenchCapabilities`
- `useWorkbenchInsights`
- 新增 `useCapabilityRegistry`
- `InlineWorkbenchBar`
- `TaskPanel/Skills`
- `TaskPanel/Connectors`
- `MCPSettings`

---

## Phase 4：显式 Browser / Computer-Use 会话

### 当前实际状态

最小闭环已落，2026-04-26 又补到 Browser / Computer productionization 基线。当前剩余 backlog 主要是 remote/external browser、CAPTCHA/anti-bot 分流和更完整的 workflow 产品化，不再是 managed browser 基础对象缺失。

已补：

- `browserSessionMode / executionIntent` 已进入 `ConversationEnvelope` 与 workbench metadata
- 聊天里的 workbench badge / trace snapshot 已能区分 `managed / desktop` 模式
- browser context blocked 时，trace 已能展示 blocked detail / hint / preview
- `browser_action` 已有 managed browser trace、DOM/a11y snapshot、viewport 和 workbench state 读回能力
- `computer_use` 已有只读 `get_state / observe`，能在行动前读 Computer Surface readiness 和 frontmost app/window
- `npm run acceptance:browser-computer` 能跑真实 headless managed browser + 只读 Computer Surface smoke
- managed browser 已有 `sessionId / profileId / profileMode / workspaceScope / artifactDir / lease / proxy / accountState / externalBridge` 这些一等状态字段
- DOM/a11y snapshot 已带 `snapshotId`，interactive element 已带 `targetRef`，stale ref 能返回 recoverable metadata
- storageState import/export、download/upload artifact、本地 browser task benchmark 已接入
- Computer Surface 已有 `background_ax` 与 `background_cgevent` 两条受控 smoke 路径

这意味着：

`browser / desktop` 已不再只是底层工具概念，而已经进入 workbench 层的显式上下文和可验收执行面。

证据：

- `src/renderer/stores/composerStore.ts`
- `src/shared/contract/turnTimeline.ts`
- `tests/renderer/components/traceNodeRenderer.launchRequest.test.ts`
- `tests/renderer/hooks/useTurnExecutionClarity.test.ts`
- `tests/unit/tools/vision/browserWorkbenchGating.test.ts`
- `tests/unit/tools/vision/computerSurfaceGating.test.ts`
- `scripts/acceptance/browser-computer-smoke.ts`
- `tests/unit/services/infra/browserServiceProfileResolver.test.ts`
- `scripts/acceptance/browser-computer-workflow-smoke.ts`
- `scripts/acceptance/browser-task-benchmark.ts`
- `scripts/acceptance/browser-computer-background-ax-smoke.ts`
- `scripts/acceptance/browser-computer-background-cgevent-smoke.ts`

### 2026-04-24 browser / desktop readiness backlog 已补项

这部分归入 Phase 4 最小闭环后的补强，不新开 Browser Use / Computer Use 的后续 phase。当前补的是发送前 readiness、执行中 trace 与工具结果展示的一致性。

2026-04-26 B+ IA 后，以下 `AbilityMenu` 证据只代表当时的历史入口；当前入口已经迁到 ChatInput `+`、Settings “对话”tab 和 Sidebar User Menu，Browser / Computer 的生产化状态以 2026-04-26 roadmap 与 workbench 架构文档为准。

已补：

- `AbilityMenu` 在发送前展示当前 `Managed browser / Computer surface` 的状态、mode、tab/window、trace 和 blocked 状态
- Desktop 模式下能把 `screen capture / accessibility / browser context / collector / Computer Surface` readiness 压到同一个 popover 里
- `AbilityMenu` 直接接入 `repairActions`，可以从同一个入口启动托管浏览器、打开权限设置或启动 desktop collector
- `workbenchPresentation` 新增 browser/computer presentation helper，避免 UI 直接拼底层 state
- `useWorkbenchBrowserSession` 的 preview 依赖覆盖 `lastTrace / surface mode`，trace 更新能反映到发送前预览
- `ToolCallDisplay` 对 `browser_action / computer_use` 展示 action preview，能看到动作摘要、目标、风险标签、mode 和 trace id
- trace node / grouped tool step 重建 `ToolCall` 时保留 result metadata，避免 `workbenchTrace` 在渲染层丢失
- grouped tool step 的折叠行已能显示 `Browser click ...` / `Computer type ...` 这类 action + target 摘要
- browser / desktop 输入类 action 不在 action preview、折叠行、collapsed result summary 或失败自动展开详情里展示原始输入文本，只展示字符数或安全目标
- `npm run acceptance:browser-computer-workflow` 能跑真实托管浏览器 workflow：DOM observe -> safe click -> DOM/readback -> trace 检查

证据：

- `src/renderer/components/features/chat/ChatInput/AbilityMenu.tsx`
- `src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/index.tsx`
- `src/renderer/components/features/chat/ToolStepGroup.tsx`
- `src/renderer/utils/browserComputerActionPreview.ts`
- `src/renderer/utils/toolStepGrouping.ts`
- `src/renderer/utils/workbenchPresentation.ts`
- `tests/renderer/components/browserComputerActionPreview.rendering.test.ts`
- `tests/renderer/utils/browserComputerActionPreview.test.ts`
- `tests/renderer/utils/toolStepGrouping.browserComputer.test.ts`
- `tests/renderer/utils/workbenchPresentation.browser.test.ts`
- `scripts/acceptance/browser-computer-workflow-smoke.ts`

### 2026-04-24 artifact consistency / acceptance backlog 已补项

这部分只补可验收性和桌面 readiness 细节，不扩 runtime 执行模型，也不把 Browser Use / Computer Use 写回待开发主项。

已补：

- `npm run acceptance:browser-computer-ui` 用系统 Chrome headless + CDP 打开真实 renderer 组件 markup
- UI smoke 覆盖 `ToolCallDisplay` action preview、失败自动展开详情、`ToolStepGroup` grouped metadata 保留
- UI smoke 同时检查 visible text 和 raw HTML，确保输入类 payload 不从真实 DOM 泄露
- Desktop readiness 将权限的 `未探测 / 未确认` 与 `未授权` 分开，避免在未主动 probe macOS 权限时误报 denied
- repair action 文案在未知状态下显示 `检查/授权`，只在明确 denied 时显示 `授权`
- Computer Surface 已补 macOS `background_ax` 最小后台面：`get_ax_elements` 先读目标 app 的 Accessibility 元素并返回 `axPath`，`targetApp + axPath` 或 `targetApp + role/name/selector` 再走后台 Accessibility；坐标类动作仍明确落回当前前台 app/window 兜底
- `acceptance:browser-computer-background-ax` 作为显式 opt-in smoke，用临时原生 Cocoa target 验证 `targetApp + axPath` 的后台 `type/click` 能真实改变目标状态；默认完整 suite 不执行这段桌面动作
- `AbilityMenu` 的 desktop readiness popover 有 SSR 回归，确认 `未探测` 与 `未授权` 在真实渲染文本和状态色上分开
- acceptance 文档把 base smoke、workflow smoke、UI smoke 拆成可重复验收清单
- `npm run acceptance:browser-computer-all` 顺序跑完整 browser/computer acceptance suite，避免只跑单段 smoke 造成假闭环

证据：

- `scripts/acceptance/browser-computer-ui-smoke.tsx`
- `scripts/acceptance/browser-computer-suite.ts`
- `src/renderer/components/features/chat/ChatInput/AbilityMenu.tsx`
- `src/renderer/hooks/useWorkbenchBrowserSession.ts`
- `tests/renderer/components/abilityMenu.browserReadiness.test.ts`
- `tests/renderer/hooks/useWorkbenchBrowserSession.readiness.test.ts`
- `docs/acceptance/browser-computer-workbench-smoke.md`

### 2026-04-26 Browser / Computer productionization 已补项

这轮按 `docs/plans/2026-04-26-browser-use-production-roadmap.md` 收到 Phase 1-6 最小闭环，但严格限定为 in-app managed browser 主路径。

已补：

- BrowserSession/Profile：persistent 兼容旧 `managed-browser-profile`，isolated profile 使用临时目录并在 close 后清理
- AccountState：storageState import/export、cookie/localStorage/sessionStorage summary、expired cookie 分类
- Snapshot/TargetRef：`snapshotId` 与 `targetRef` 贯穿 DOM/a11y observe、click/type、stale recovery 和 trace
- Artifact：download/upload 的 name/hash/mime/size/session 摘要进入 managed browser artifact 区
- Lease/Proxy：managed browser 有 lease/TTL、crash cleanup、proxy schema；默认 proxy mode 是 `direct`
- External bridge：显式记录 `unsupported`，不偷读外部 Chrome profile / cookie
- Phase 6 benchmark：navigation、form、extract、login-like、download/upload、failure recovery、redaction export、fixture-only recipe rerun
- Computer Surface：background AX 与 background CGEvent 均有临时 native target smoke，和 foreground fallback 边界分开

仍不宣称完成：

- 不做远程浏览器池、外部 CDP attach、外部 profile、extension bridge
- 不承诺 CAPTCHA / anti-bot 自动处理
- 不把受控 fixture smoke 外推成任意桌面 app 后台自动化已成熟

证据：

- `src/shared/contract/desktop.ts`
- `src/main/services/infra/browserService.ts`
- `src/main/services/infra/browserProvider.ts`
- `src/main/tools/vision/browserAction.ts`
- `src/main/tools/vision/computerUse.ts`
- `src/renderer/hooks/useWorkbenchBrowserSession.ts`
- `tests/unit/services/infra/browserServiceProfileResolver.test.ts`
- `scripts/acceptance/browser-computer-workflow-smoke.ts`
- `scripts/acceptance/browser-task-benchmark.ts`
- `docs/acceptance/browser-computer-workbench-smoke.md`

### Phase 4 原目标与当前口径

原目标是把已有的 browser / computer-use / native desktop 能力从“工具存在”升级为“产品可理解入口”。当前最小闭环已落，后续只按 readiness / artifact consistency backlog 推进。

### 为什么值钱

当前仓库里 browser / desktop 基础并不弱：

- `Browser` / `browser_action` / `browser_navigate`
- `computer_use`
- `nativeDesktop`
- frontmost context / screenshot / desktop collector

原问题是产品入口不清楚，用户心智容易停在：

`模型自己会不会调用这些工具`

Phase 4 最小闭环要拉回到：

`这条消息要不要连桌面 / 连浏览器 / 用哪种浏览器上下文`

### 原子项对应状态

#### 4.1 Browser Session Chip

历史上由 AbilityMenu、workbench badge 与 trace snapshot 覆盖最小显式入口；2026-04-26 B+ 后入口迁到 ChatInput `+`、Settings “对话”tab 和 Sidebar User Menu，仍要能区分三种状态：

- 未接入
- 使用托管浏览器
- 绑定当前桌面浏览器上下文

#### 4.2 Desktop Readiness Gate

readiness popover 已覆盖下列基础状态；后续只继续补更完整的修复路径和状态一致性：

- screen capture permission
- accessibility permission
- browser context support
- collector status

不满足时，给明确修复路径。这部分属于 backlog，不再作为新的 phase。

#### 4.3 Session Preview

已有轻量 browser / desktop session preview 与 action preview；后续补 artifact 展示与恢复一致性：

- 当前 URL / title
- 当前 frontmost app
- 最近截图时间
- 当前 session mode

#### 4.4 Workbench Intent

browser / computer-use 已进入 workbench intent；当前最小 intent 是：

- `preferBrowserSession`
- `preferDesktopContext`
- 后续执行策略开关

这样后续执行解释层才能说清楚“为什么这轮去动浏览器了”。

### 最小成功标准（已覆盖，继续补外部边界和体验一致性）

- 用户在发送前就知道这条消息有没有 browser / desktop 上下文
- 权限或 collector 未就绪时，不会再是黑箱失败
- browser/computer-use 不再只是 tool 层概念，而成为 workbench 层概念
- managed browser 的会话、账号态、产物、恢复、脱敏都能通过本地 fixture 验收

### 后续只看这些落点

- `nativeDesktop.ts`
- settings 中的 desktop section
- `InlineWorkbenchBar`
- `ConversationEnvelope.context.executionIntent`

---

## Phase 5：Session-Native Workspace

### 当前实际状态

最小闭环已落。

当前最小落点是：

- Sidebar / current session bar 已把 `Replay / Review / Resume / Export / Reopen Workspace` 这类 session-native 入口接进主产品
- 历史 session 已能把持久化的 workspace / routing / capability 选择回灌到当前 session
- `Review Queue -> Replay -> 回到当前产品入口` 已不再依赖“手工找最近文件”

这轮口径里，`Phase 5` 的完成定义不是“把所有 session UX 都做满”，而是：

`用户已经可以把会话当工作单元来打开、回看、回用，而不只是长滚动流。`

证据：

- `src/renderer/components/Sidebar.tsx`
- `src/renderer/stores/composerStore.ts`
- `tests/renderer/components/sidebar.reviewActions.test.ts`
- `tests/renderer/components/chatView.sessionWorkspace.actions.test.ts`

### Phase 5 原目标与当前口径

原目标是让用户把会话当工作单元来管理，而不是继续把所有内容当成一个长滚动流。当前最小闭环已落，后续是 session search / background / long-session robustness 增强。

### 为什么值钱

这块不是 workbench 的边缘问题，而是 workbench 长期可用性的必要条件。

如果没有 session-native workspace：

- 聊天 workbench 越强，历史会话越难找
- 恢复、导出、回顾、继续工作都不顺
- 后续的评测和学习闭环也无从挂载

### 原子项对应状态

#### 5.1 Sidebar + Main 会话结构

已具备 Sidebar / current session bar 的最小入口；完整结构继续围绕：

- sidebar：会话列表
- main：当前会话完整 trace

推进，不再把 Phase 5 重新写成待开发主项。

#### 5.2 Session Metadata

最小 metadata 已能支撑回看与回用；完整维度仍是增强：

- title
- live / done / error
- 最近活动时间
- turn count
- current workbench snapshot

#### 5.3 Resume / Background / Export

Replay / Review / Resume / Export / Reopen Workspace 已接入最小入口；完整 UX 仍围绕：

- resume
- move to background
- export markdown
- reopen current workspace

#### 5.4 Session Search / Filter

后续增强再补：

- title keyword
- capability usage
- agent usage
- status
- date range

### 最小成功标准（已覆盖，继续补完整 UX）

- 用户能把“当前工作”和“历史工作”清楚分开
- 恢复一个老会话时，不需要回忆它当时用了什么 workbench 上下文
- 后台运行中的会话能被稳定感知

### 后续增强落点

- session list / history view
- `backgroundTaskManager`
- `resume.ts`
- `exportMarkdown.ts`

---

## Phase 6：Review / Eval / Learning 闭环（已落 6.1 + 6.2，另有最小 6.3 sink + 6.4 reuse）

### 目标

把 workbench 中的成功/失败经验沉淀成可复盘、可评测、可回用的资产。

### 当前实现状态（2026-04-18 closing + 2026-04-24 productization landings）

- 已落地：`6.1 Unified Trace Identity`
- 已落地：`6.2 Review Queue`
- 已落地（最小）：`6.3 Replay / failure attribution -> failure_followup sink`
- 已落地（最小）：`6.4 Historical session -> current session workbench reuse`
- 已落地（最小产品化）：`6.3 Failure-to-Capability Feedback` 的 `skill / dataset / prompt-policy / capability-health` 分流 metadata、UI 标签与本地 `failureAsset` draft 持久化
- 已落地（最小产品化）：`6.4 Named Presets` 的本地命名 preset 资产库、保存和应用
- 已落地（能力层）：`6.4 Recipes` 的 contract/store CRUD、从 presets 生成 recipe、hydrate / upsert / delete / list 本地持久化
- 未落地：recipe 管理 UI、多步 recipe 执行编排、preset/recipe 搜索/分享/版本化管理

因此按这轮 closing 的标准，`Phase 6` 已可以视为完成并关账；当前已经接通 `review/replay` 闭环、failure follow-up 多分流 metadata + asset draft、session-backed reuse、本地命名 preset，以及 recipe 的本地能力层。但 recipe 管理 UI、多步执行编排和 preset/recipe 管理增强仍留在后续 roadmap，不算这轮已交付。

### 为什么值钱

如果没有这层，workbench 只是在提高单次体验，不会形成产品复利。

### 子项

#### 6.1 Unified Trace Identity

把：

- 会话 trace
- run
- case run
- review

串成稳定 identity，而不是各页面各自读最近文件。

当前完成定义：

- `Replay / Eval Center / Review Queue` 至少共享同一个 `session:<sessionId>` trace identity

证据：

- `src/shared/contract/reviewQueue.ts`
- `src/main/evaluation/telemetryQueryService.ts`
- `src/main/evaluation/reviewQueueService.ts`
- `tests/unit/evaluation/telemetryQueryService.test.ts`
- `tests/unit/evaluation/reviewQueueService.test.ts`

#### 6.2 Review Queue

把“这条会话值得标注/值得回流”的入口接到主产品里，不只放在评测中心。

当前完成定义：

- 当前 session bar、session list、Replay failure follow-up 都能把会话写进持久化 `Review Queue`
- `Review Queue` 可以直接回到对应 `Replay`

证据：

- `src/main/evaluation/reviewQueueService.ts`
- `src/renderer/stores/evalCenterStore.ts`
- `src/renderer/components/Sidebar.tsx`
- `tests/renderer/stores/evalCenterStore.reviewQueue.test.ts`
- `tests/renderer/components/sidebar.reviewActions.test.ts`
- `tests/e2e/review-queue.e2e.spec.ts`

#### 6.3 Failure-to-Capability Feedback（已落最小多分流 + asset draft）

当一轮失败时，支持沉淀成：

- 当前已支持：从 Replay / failure attribution 把会话写入 `failure_followup` sink，带上 `skill / dataset / prompt-policy / capability-health` 分流 metadata，回到 Review Queue 继续跟进，并生成本地 `failureAsset` draft

- 新 skill 候选
- 新 dataset case
- 新 prompt/routing policy
- 新 capability health issue

当前最小落点：

- Replay 已能产出 `failureAttribution`
- `ReplayAnalyticsSidebar` 已能把失败会话写入 `failure_followup` sink
- `ReviewQueue` 会持久化 `failureCapability` metadata，并在 Replay / Review Queue 列表展示分流标签
- `review_queue_failure_assets` 会为 `failure_followup + failureCapability` 生成 draft，并随 `ReviewQueueService.listItems()` 返回 `failureAsset`
- sink 写入后，会话回到持久化 `Review Queue`，并保留 Replay 回看入口

当前还没做：

- richer triage、批量处理、asset apply/export、归因后的真实资产流转

为什么现在仍可把 `Phase 6` 关账：

- 因为这轮 Phase 6 的完成定义是“失败会话能进入 review/replay 的回流链，并带上可执行的分流方向和本地资产草稿”，这条最小闭环已经成立
- 但这不等于完整 triage / 批处理 / asset apply / 自动建真实资产已经完成；那部分仍在 backlog

证据：

- `src/main/evaluation/telemetryQueryService.ts`
- `src/shared/contract/reviewQueue.ts`
- `src/main/evaluation/reviewQueueService.ts`
- `src/renderer/components/features/evalCenter/ReplayAnalyticsSidebar.tsx`
- `src/renderer/components/features/evalCenter/SessionListView.tsx`
- `src/renderer/stores/evalCenterStore.ts`
- `tests/unit/shared/reviewQueue.test.ts`
- `tests/unit/evaluation/reviewQueueService.test.ts`
- `tests/renderer/components/evalCenter.replayAnalyticsSidebar.failureFollowup.test.ts`
- `tests/renderer/components/evalCenter.sessionListView.reviewQueue.test.ts`
- `tests/renderer/stores/evalCenterStore.reviewQueue.test.ts`

#### 6.4 Reusable Recipes / Presets（已落本地命名 preset + recipe store，未落管理 UI / 执行编排）

把高频 workbench 组合沉淀成：

- 当前已支持：从历史 session 把已持久化的 workbench 配置复用到当前会话
- 当前已支持：从当前/历史 session 保存本地命名 preset，并应用回 composer
- 当前已支持：从一组 presets 生成 recipe，本地 hydrate / upsert / delete / list 持久化
- 当前边界：preset 管理只到本地 localStorage 和 Sidebar 右键菜单；recipe 只到 contract/store 能力层；不提供管理 UI、多步执行编排、搜索、分享或版本化管理

- “代码审查”
- “发版检查”
- “browser scrape + summarize”
- “mail + calendar + reminders”

这些不是 macro，而是 workbench preset/recipe。当前实现已经到本地命名 preset 的最小产品形态和 recipe 的本地能力层，还没到完整 preset/recipe 产品。

当前最小落点：

- `historical session -> current session` 的 workbench reuse 已成立
- reuse 基于 session 已持久化的 `workingDirectory / workbenchProvenance / workbenchSnapshot`
- `WorkbenchPreset` / `WorkbenchRecipe` 契约已定义
- `workbenchPresetStore` 已支持本地 preset 保存、hydrate、rename、delete
- `workbenchPresetStore` 已支持 recipe create/upsert/delete/clear/get/list 和 localStorage 持久化
- `createWorkbenchRecipeFromPresets` / `normalizeWorkbenchRecipe` 已支持从 presets 生成本地 recipe 并规范化 step/context
- `composerStore.applyWorkbenchPreset` 已支持把命名 preset 应用回当前 composer

当前还没做：

- recipe 管理 UI 与多步执行编排
- 可搜索/可分享/可版本化的 preset/recipe 管理

为什么现在仍可把 `Phase 6` 关账：

- 因为这轮要验证的是“历史工作台能否回灌到当前工作台，并能沉淀成可命名资产 / 可组合 recipe 草稿”，这条最小闭环已经成立
- 但不能把它写成“完整 presets / recipes 管理产品已完成”

证据：

- `src/main/services/core/repositories/SessionRepository.ts`
- `src/shared/contract/workbenchPreset.ts`
- `src/renderer/stores/workbenchPresetStore.ts`
- `tests/unit/shared/workbenchPreset.test.ts`
- `tests/renderer/stores/workbenchPresetStore.test.ts`
- `src/renderer/stores/composerStore.ts`
- `src/renderer/components/Sidebar.tsx`
- `tests/renderer/stores/composerStore.test.ts`
- `tests/renderer/components/sidebar.reviewActions.test.ts`

### 成功标准

- 一次成功的工作台使用，可以通过 `session-backed reuse` 回灌到下次当前会话
- 一次失败的工作台使用，可以进入 review/eval 体系
- 会话、评测、学习不再是三条平行线

### 建议落点

- eval center
- telemetry / replay
- capability registry
- session metadata

---

## 5. 横向工程工作流

这些不对应单个 phase，但每一阶段都应同步推进：

### 5.1 共享契约继续收口

继续把 workbench 相关概念抽成共享契约：

- capability status
- capability actions
- trace node taxonomy
- workbench event schema

### 5.2 展示原件继续统一

已开始的 `WorkbenchPrimitives` 应继续扩：

- status chip
- action chip
- section card header
- inline empty state
- blocking reason row

### 5.3 性能与长会话稳定性

重点关注：

- 长会话下的 trace 渲染
- capability registry 的派生开销
- 事件流更新频率
- TaskPanel 和聊天区双渲染的重复成本

### 5.4 测试策略

每一阶段至少保证：

- 纯函数 / builder 测试
- renderer 静态渲染测试
- 关键交互 smoke
- 类型检查

对于 browser / native desktop：

- 优先做 mockable contract tests
- 再补有限的桌面端 smoke

## 6. 推荐节奏

这部分不再描述 `Phase 1-6` 的原始开发顺序，而是描述在当前代码基础上，剩余 backlog 更适合怎样推进。

### 先收口的 backlog

- `Phase 3` 后续产品化：native connector lifecycle 与设置页管理入口已有最小闭环；剩余是非 native connector、完整权限修复向导和统一管理面
- `Phase 4/5` 已落最小闭环后的稳定性与体验补强：browser / desktop 外部边界、session search、background/long-session robustness
- `Phase 6.3/6.4` 后续产品化：failure-to-capability 的 triage / 批处理 / asset apply，recipe 管理 UI / 多步执行编排，preset/recipe 搜索/分享/版本化管理
- `Live Preview V3`：partial HMR、批注/多选、Next.js 支持重新评估；V2 不再扩大范围
- `Semantic Tool UI`：提高 `_meta` 质量和 provider 覆盖率，但保留 fallback generator，不让 UI 可读性依赖单一模型配合

原因：

- 这些是当前文档与产品口径里仍不能写成“已完整完成”的部分
- 其中 `connector lifecycle` 的非 native / 统一管理面是最直接的产品缺口，`6.3/6.4` 的 asset apply 和 recipe 管理 UI 是最明确的复利 backlog
- 其余 `Phase 1/2/4/5/6` 已完成的最小闭环，应以稳定性和口径清晰为主，而不是重新开 spec

## 7. 我自己的优先级判断

如果只看当前还值得继续投入的 3 件事：

1. `Connector lifecycle` 非 native / 统一管理面
2. `Failure-to-Capability` triage / 批处理 / asset apply
3. `Named presets / recipes` 的管理 UI、搜索/分享/版本化和 recipe 执行编排

原因很直接：

- 第一项解决“native 已能继续，其他 connector 和管理面还没统一”
- 第二项解决“失败会话已有分流方向和 asset draft，但还没进入真实改进资产流转”
- 第三项解决“preset 已能命名保存，recipe 也有能力层，但 UI、执行、搜索、分享、版本管理还没成型”

而：

- `Phase 1/2` 的 routing / execution clarity 主链
- `Phase 4/5` 的最小 browser / workspace 闭环
- `Phase 6` 的 unified trace + review queue + 最小 follow-up / reuse

已经具备“最小可用”的完成度，这轮不该再写成待开发主项。

## 8. 下一步建议

按当前代码与文档口径，下一步不该再补 `Phase 2` 之类的实现 spec；更合理的是直接围绕 backlog 开新轮次。

建议按下面顺序单独开题：

1. `Connector lifecycle` 的非 native connector 和统一管理面
2. `Failure-to-Capability` 从 asset draft 到 triage / apply / export 的流转方式
3. `Named presets / recipes` 的管理 UI、多步执行编排、搜索、分享和版本化边界
4. `Live Preview V3` 的 partial HMR / 多选 / Next 支持重新评估
5. `Browser external boundary` 的 remote pool / external CDP / extension bridge 产品边界

这样下一轮才是在真实 backlog 上继续，而不是对已经落地的 `Phase 1-6` 重新写一遍计划。

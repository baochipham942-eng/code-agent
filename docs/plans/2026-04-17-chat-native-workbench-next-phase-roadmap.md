# Chat-Native Workbench 下一阶段完整路线图

日期：2026-04-17  
状态：已按 2026-04-18 实际状态对齐  
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
- `Phase 3` 已落基础骨架，但 `connector lifecycle` 还没有完成产品化闭环，不能关账
- `Phase 4` 已有最小显式 browser / desktop session 心智
- `Phase 5` 已有最小 session-native workspace 闭环
- `Phase 6` 已按 `trace identity -> review queue -> failure_followup sink -> session-backed reuse` 的最小闭环关账

一句话判断：

`后续 backlog 不该再笼统写成“继续做 Phase 2-6”，而要写成“补齐尚未产品化的 richer backlog”。`

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
- `failure_followup sink`：Replay 里的 failure attribution 已能回流到 Review Queue
- `session-backed reuse`：历史 session 的 workbench 配置已能回灌到当前 session

这意味着：

`剩下更值钱的，不是再证明“这些能力能不能做”，而是把还没关账的 backlog 说清楚。`

## 3. 优先级总览

### P0：还没关账的 backlog

1. `Connector lifecycle` 的真实产品化闭环
2. `Failure-to-Capability` 的多分流回流
3. 命名 `presets / recipes` 资产库

### P1：做得更完整，而不是补第一版

4. 更完整的 browser / desktop readiness gate
5. 更强的 session search / background / long-session robustness

### P2：后续增强

6. `Multi-agent team productization`
7. 更丰富的 personalization
8. `Performance / virtualization`

### 明确不建议现在做

- 重写 swarm 引擎
- 重做整套 settings 信息架构
- 引入更复杂的 team/channel 数据模型
- 做“插件商城”式大而全 capability marketplace

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

已落基础骨架，但不能关账。

当前已落：

- `capability registry` / lifecycle 字段 / unified sheet 已有
- `skill mount` 与 `MCP retry` 有最短路径 quick action
- selected capability 会展示真实 blocked reason / hint

当前未落：

- connector 没有一键 `connect / retry` 闭环
- 没有统一的“发现 -> 安装 / 连接 / 挂载 -> 修复 -> 授权 -> 移除 / 断开”产品路径
- 还不能把 Phase 3 写成“任一 capability 都能从不可用走到可用于当前 turn”

当前产品口径必须明确：

`connector lifecycle` 还没有完成产品化；blocked connector 只展示真实 blocked reason / hint，不再暗示有假 quick action 闭环。

证据：

- `src/renderer/utils/workbenchCapabilityRegistry.ts`
- `src/renderer/utils/workbenchQuickActions.ts`
- `src/renderer/components/workbench/WorkbenchCapabilitySheetLite.tsx`
- `tests/renderer/utils/workbenchCapabilityRegistry.test.ts`
- `tests/renderer/utils/workbenchQuickActions.test.ts`

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

最小闭环已落，但 richer desktop readiness backlog 仍在。

当前最小落点是：

- `browserSessionMode / executionIntent` 已进入 `ConversationEnvelope` 与 workbench metadata
- 聊天里的 workbench badge / trace snapshot 已能区分 `managed / desktop` 模式
- browser context blocked 时，trace 已能展示 blocked detail / hint / preview

这意味着：

`browser / desktop` 已不再只是底层工具概念，而已经进入 workbench 层的显式上下文。

证据：

- `src/renderer/stores/composerStore.ts`
- `src/shared/contract/turnTimeline.ts`
- `tests/renderer/components/traceNodeRenderer.launchRequest.test.ts`
- `tests/renderer/hooks/useTurnExecutionClarity.test.ts`

### 目标

把已有的 browser / computer-use / native desktop 能力从“工具存在”升级为“产品可理解入口”。

### 为什么值钱

当前仓库里 browser / desktop 基础并不弱：

- `Browser` / `browser_action` / `browser_navigate`
- `computer_use`
- `nativeDesktop`
- frontmost context / screenshot / desktop collector

但产品入口还不清楚。用户现在的心智仍然是：

`模型自己会不会调用这些工具`

而不是：

`这条消息要不要连桌面 / 连浏览器 / 用哪种浏览器上下文`

### 子项

#### 4.1 Browser Session Chip

在 workbench bar 里新增显式 `Browser` 区块，至少支持三种状态：

- 未接入
- 使用托管浏览器
- 绑定当前桌面浏览器上下文

#### 4.2 Desktop Readiness Gate

在 native desktop 模式下显式展示：

- screen capture permission
- accessibility permission
- browser context support
- collector status

不满足时，给明确修复路径。

#### 4.3 Session Preview

建立轻量 browser / desktop session preview：

- 当前 URL / title
- 当前 frontmost app
- 最近截图时间
- 当前 session mode

#### 4.4 Workbench Intent

把 browser / computer-use 变成 workbench intent，而不是纯工具：

- `preferBrowserSession`
- `preferDesktopContext`
- `allowBrowserAutomation`

这样后续执行解释层才能说清楚“为什么这轮去动浏览器了”。

### 成功标准

- 用户在发送前就知道这条消息有没有 browser / desktop 上下文
- 权限或 collector 未就绪时，不会再是黑箱失败
- browser/computer-use 不再只是 tool 层概念，而成为 workbench 层概念

### 建议落点

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

### 目标

让用户把会话当工作单元来管理，而不是继续把所有内容当成一个长滚动流。

### 为什么值钱

这块不是 workbench 的边缘问题，而是 workbench 长期可用性的必要条件。

如果没有 session-native workspace：

- 聊天 workbench 越强，历史会话越难找
- 恢复、导出、回顾、继续工作都不顺
- 后续的评测和学习闭环也无从挂载

### 子项

#### 5.1 Sidebar + Main 会话结构

实现真正的：

- sidebar：会话列表
- main：当前会话完整 trace

不是继续在单流里插 divider。

#### 5.2 Session Metadata

每个 session 至少展示：

- title
- live / done / error
- 最近活动时间
- turn count
- current workbench snapshot

#### 5.3 Resume / Background / Export

把已有底层能力产品化：

- resume
- move to background
- export markdown
- reopen current workspace

#### 5.4 Session Search / Filter

至少支持：

- title keyword
- capability usage
- agent usage
- status
- date range

### 成功标准

- 用户能把“当前工作”和“历史工作”清楚分开
- 恢复一个老会话时，不需要回忆它当时用了什么 workbench 上下文
- 后台运行中的会话能被稳定感知

### 建议落点

- session list / history view
- `backgroundTaskManager`
- `resume.ts`
- `exportMarkdown.ts`

---

## Phase 6：Review / Eval / Learning 闭环（已落 6.1 + 6.2，另有最小 6.3 sink + 6.4 reuse）

### 目标

把 workbench 中的成功/失败经验沉淀成可复盘、可评测、可回用的资产。

### 当前实现状态（2026-04-18 closing + 6.3/6.4 minimal landings）

- 已落地：`6.1 Unified Trace Identity`
- 已落地：`6.2 Review Queue`
- 已落地（最小）：`6.3 Replay / failure attribution -> failure_followup sink`
- 已落地（最小）：`6.4 Historical session -> current session workbench reuse`
- 未落地：`6.3 Failure-to-Capability Feedback` 的多分流产品化
- 未落地：`6.4 Reusable Recipes / Presets` 的命名资产库 / recipe 产品化

因此按这轮 closing 的标准，`Phase 6` 已可以视为完成并关账；当前已经接通 `review/replay` 闭环、最小 `failure follow-up` sink，以及最小 `session-backed reuse`。但 `6.3` 的多分流产品化和 `6.4` 的命名 preset/recipe 资产库仍留在后续 roadmap，不算这轮已交付。

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

#### 6.3 Failure-to-Capability Feedback（仅最小 sink 已落地）

当一轮失败时，支持沉淀成：

- 当前已支持：从 Replay / failure attribution 把会话写入 `failure_followup` sink，回到 Review Queue 继续跟进

- 新 skill 候选
- 新 dataset case
- 新 prompt/routing policy
- 新 capability health issue

当前最小落点：

- Replay 已能产出 `failureAttribution`
- `ReplayAnalyticsSidebar` 已能把失败会话写入 `failure_followup` sink
- sink 写入后，会话回到持久化 `Review Queue`，并保留 Replay 回看入口

当前还没做：

- failure 结果按不同 sink 分流到 `skill / dataset / prompt-policy / capability-health`
- richer triage、批量处理、归因后的资产沉淀

为什么现在仍可把 `Phase 6` 关账：

- 因为这轮 Phase 6 的完成定义是“失败会话能进入 review/replay 的回流链”，这条最小闭环已经成立
- 但这不等于 `Failure-to-Capability` 本身已经完整产品化；那部分仍在 backlog

证据：

- `src/main/evaluation/telemetryQueryService.ts`
- `src/renderer/components/features/evalCenter/ReplayAnalyticsSidebar.tsx`
- `src/renderer/stores/evalCenterStore.ts`
- `tests/renderer/components/evalCenter.replayAnalyticsSidebar.failureFollowup.test.ts`
- `tests/renderer/stores/evalCenterStore.reviewQueue.test.ts`

#### 6.4 Reusable Recipes / Presets（已落最小 session-backed reuse，未落命名 preset/recipe）

把高频 workbench 组合沉淀成：

- 当前已支持：从历史 session 把已持久化的 workbench 配置复用到当前会话
- 当前边界：只复用 session 上已经持久化的 workspace / routing / capability 选择，不提供命名 preset 管理、recipe 编排或跨 session 资产库

- “代码审查”
- “发版检查”
- “browser scrape + summarize”
- “mail + calendar + reminders”

这些不是 macro，而是 workbench preset。当前实现只到 `session-backed reuse`，还没到完整 preset 产品。

当前最小落点：

- `historical session -> current session` 的 workbench reuse 已成立
- reuse 基于 session 已持久化的 `workingDirectory / workbenchProvenance / workbenchSnapshot`

当前还没做：

- 命名 preset 资产库
- recipe 编排
- 可搜索/可分享/可版本化的 preset 管理

为什么现在仍可把 `Phase 6` 关账：

- 因为这轮要验证的是“历史工作台能否回灌到当前工作台”，不是“preset 产品是否完整”
- 这条 `session-backed reuse` 已经成立，所以 `Phase 6` 的 reuse 子目标可以记为最小闭环已落
- 但不能把它写成“完整 presets / recipes 已完成”

证据：

- `src/main/services/core/repositories/SessionRepository.ts`
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

- `Phase 3` 未关账部分：真实 connector lifecycle（至少要有明确 connect/retry 闭环，或产品上明确不做）
- `Phase 4/5` 已落最小闭环后的稳定性与体验补强：browser / desktop artifact 的展示与恢复一致性
- `Phase 6.3/6.4` 未产品化部分：failure-to-capability 多分流、命名 preset/recipe 资产库

原因：

- 这些是当前文档与产品口径里仍不能写成“已完整完成”的部分
- 其中 `connector lifecycle` 是最直接的产品缺口，`6.3/6.4` 是最明确的复利 backlog
- 其余 `Phase 1/2/4/5/6` 已完成的最小闭环，应以稳定性和口径清晰为主，而不是重新开 spec

## 7. 我自己的优先级判断

如果只看当前还值得继续投入的 3 件事：

1. `Connector lifecycle` 真闭环或明确砍边界
2. `Failure-to-Capability` 多分流产品化
3. `Named presets / recipes` 资产化

原因很直接：

- 第一项解决“用户看到 blocked 但没法真的继续”
- 第二项解决“失败会话只能回 review queue，还不能沉淀成不同改进动作”
- 第三项解决“历史 session 能复用，但还没有可命名、可管理、可分享的资产层”

而：

- `Phase 1/2` 的 routing / execution clarity 主链
- `Phase 4/5` 的最小 browser / workspace 闭环
- `Phase 6` 的 unified trace + review queue + 最小 follow-up / reuse

已经具备“最小可用”的完成度，这轮不该再写成待开发主项。

## 8. 下一步建议

按当前代码与文档口径，下一步不该再补 `Phase 2` 之类的实现 spec；更合理的是直接围绕 backlog 开新轮次。

建议按下面顺序单独开题：

1. `Connector lifecycle` 是否要做真 connect/retry 闭环；如果不做，就把产品边界写死并清掉误导入口
2. `Failure-to-Capability` 的 sink 分流模型和归档方式
3. `Named presets / recipes` 的资产模型、命名、管理和编排边界

这样下一轮才是在真实 backlog 上继续，而不是对已经落地的 `Phase 1-6` 重新写一遍计划。

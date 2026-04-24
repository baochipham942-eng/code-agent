# Chat-Native Agent Workbench 架构

> 稳定态架构文档。
>
> 产品背景、Phase 级实施顺序、逐文件 slice 拆分请看 `docs/plans/2026-04-16-chat-native-agent-workbench-plan.md` 以及 `docs/plans/2026-04-1{6,7}-*-implementation-spec.md`。
> Accio 对标分析见 `docs/analysis/2026-04-16-accio-vs-code-agent-core-differences.md`。
> 架构决策见 [ADR-011](../decisions/011-chat-native-workbench.md)。

## 0. 它解决什么

`code-agent` 的能力本身不弱，弱在入口。2026-04-16 以前，用户用到 workspace、skills、MCP、connector、routing、browser 这些能力时，每一类都在不同的侧面板或设置页里。聊天只是一个空白输入框。

Workbench 把这些能力收成聊天主链路的一部分。它不改 orchestration 引擎，只做四件事：

1. 聊天发送是 `ConversationEnvelope`，携带 workspace / routing / capability 选择
2. 输入框上方的 `InlineWorkbenchBar` 把选择点放在离文本最近的地方
3. 关键审批（swarm launch）用内联卡片拉回聊天流，而不是侧面板
4. 每个 turn 内投影出 `workbench_snapshot / blocked / routing / artifact` 四层执行解释

目标是让"选择"、"执行"、"解释"这三步都在聊天主链路里闭环，而不是分散在 sidecar 里。

## 1. 5 条概念流

Workbench 是一个整合功能，不是一条线性 phase。代码层面可以按 5 条并列的概念流来理解，每一条都在 `0a6e215e` 这个整合 commit 里关账了 Phase 1-2 的最小闭环。

| 流 | 做了什么 | 关账边界 | Backlog |
|----|----------|----------|---------|
| **A. 主体** | `ConversationEnvelope` + `InlineWorkbenchBar` + 内联 `LaunchRequestCard` | workspace / routing / skills / connectors / MCP 进入主发送链 | — |
| **B. Execution Clarity** | Turn 级 timeline：`workbench_snapshot` / `blocked` / `routing_evidence` / `artifact_ownership` | Direct routing 持久化后可 replay | — |
| **C. Review Queue、session 复用与本地 preset/recipe** | `trace identity` + `Review Queue` + `failure_followup` sink / asset draft + `session-backed reuse` + 本地命名 preset/recipe store | 失败/成功都能进复盘链路，失败会话可生成本地资产草稿；历史 session 可回灌当前 workbench；session 可保存成本地命名 preset 并回灌 composer；preset 可组合成本地 recipe | recipe 管理 UI / 执行编排、完整 preset/recipe 管理、`failure-to-capability` triage / apply |
| **D. Direct Routing (@agent)** | `@agent` mention → messageMetadata → 主进程持久化 → fanout | renderer optimistic + 主进程持久化再分发；失败回滚；replay fallback 可重建 | — |
| **E. Browser/Desktop 显式入口** | `browserSessionMode / executionIntent` 进入 envelope，workbench badge 区分 `managed / desktop` | 聊天里能看到是否连浏览器/桌面，blocked 有 reason + hint，基础 readiness / action preview / acceptance smoke 已接入 | browser / desktop readiness 与 artifact consistency 补强 |

## 2. 关键数据结构

稳定态的核心契约分布在 `src/shared/contract/` 里。以下是 workbench 真正承载语义的几个文件，不是所有扩展过的契约。

### 2.1 ConversationEnvelope

**文件**：`src/shared/contract/conversationEnvelope.ts`

聊天发送的消息外壳。`agent:send-message` IPC 和 `appService.sendMessage()` 都接这个类型。

```ts
interface ConversationEnvelope {
  content: string;
  sessionId?: string;
  attachments?: MessageAttachment[];
  options?: AppServiceRunOptions;
  context?: {
    workingDirectory?: string | null;
    routing?: { mode: 'auto' | 'direct' | 'parallel'; targetAgentIds?: string[] };
    selectedSkillIds?: string[];
    selectedConnectorIds?: string[];
    selectedMcpServerIds?: string[];
    browserSessionMode?: 'managed' | 'desktop' | null;
    executionIntent?: { preferBrowserSession?: boolean; preferDesktopContext?: boolean };
  };
}
```

规则：

- `ConversationEnvelope.context` 是**消息级上下文**，不是全局设置快照。切 workspace 只影响下一条消息，不改全局。
- 旧 `string` payload 和 `{ content, attachments, sessionId }` object payload 仍由 `agent.ipc.ts` 的 `normalizeEnvelope()` 兼容。
- 发送链向 user message 写入 `metadata.workbench` 作为可持久化投影。

### 2.2 WorkbenchMessageMetadata

**文件**：同上 + `src/shared/contract/message.ts`

只挂在 `user` 消息的 `metadata.workbench` 上，不挂 assistant/tool/system。这样解释层和执行层不会混。

```ts
interface MessageMetadata {
  workbench?: {
    workingDirectory?: string | null;
    routingMode?: 'auto' | 'direct' | 'parallel';
    targetAgentIds?: string[];
    selectedSkillIds?: string[];
    selectedConnectorIds?: string[];
    selectedMcpServerIds?: string[];
    browserSessionMode?: 'managed' | 'desktop' | null;
    directRoutingDelivery?: {
      requestedTargets: string[];
      deliveredTargets: string[];
      missingTargets?: string[];
    };
  };
}
```

`directRoutingDelivery` 是 Direct routing 的 replay 兜底——runtime event 消失后，turn timeline projection 仍能据此重建证据。

### 2.3 TurnTimeline

**文件**：`src/shared/contract/turnTimeline.ts`

Turn 内执行解释节点。消费者是聊天 trace renderer，也允许 `TaskPanel` 等 sidecar 后续复用这层 DTO。

```ts
type TurnTimelineNodeKind =
  | 'workbench_snapshot'
  | 'blocked_capabilities'
  | 'routing_evidence'
  | 'artifact_ownership';

interface TurnTimelineNode {
  id: string;
  kind: TurnTimelineNodeKind;
  timestamp: number;
  tone: 'neutral' | 'info' | 'warning' | 'success' | 'error';
}
```

Trace 层只新增一种 wrapper 节点 `turn_timeline`，不同种类通过 `kind` 区分。这样 `TraceNodeRenderer` 只有一个新入口，不会被 4 个 slice 各加一遍分支。

### 2.4 SessionWorkspace 派生

**文件**：`src/shared/contract/sessionWorkspace.ts` + `src/main/app/workbenchTurnContext.ts`

Session 维度的 workbench provenance：哪条消息用了哪些能力、最近一次 direct routing 分发到哪里、历史 session 的 workbench 快照。用于：

- Sidebar 的 `Resume` / `Reopen Workspace` 按钮
- 历史 session 回灌当前 composer（Phase 5 session-backed reuse）
- Replay / Review Queue 在 live event 缺席时做 fallback

### 2.5 Review Queue

**文件**：`src/shared/contract/reviewQueue.ts` + `src/main/evaluation/reviewQueueService.ts`

把"这条会话值得标注/回流"接到主产品。当前 session bar、session list、Replay failure follow-up 都写入同一个持久化队列，条目都带稳定 `trace identity`（形如 `session:<sessionId>`），所以 Eval Center / Replay / 主产品三个入口看到的是同一批数据。`failure_followup + failureCapability` 会额外生成本地 `failureAsset` draft，供后续 triage / apply / export 使用。

## 3. 数据流

### 3.1 发送链（普通 Auto / Parallel）

```
ChatInput.handleSubmit()
  → composerStore.buildContext()
  → ConversationEnvelope {content, context}
  → useAgent.sendMessage(envelope)
    → optimistic user message（已带 metadata.workbench）
    → ipc.invoke('agent:send-message', envelope)
      → agent.ipc.ts normalize
      → agentAppService.sendMessage(envelope)
        → 如有 workingDirectory：orchestrator.setWorkingDirectory()
        → 组装 MessageMetadata.workbench
        → agentOrchestrator.sendMessage(content, attachments, options, messageMetadata)
          → 持久化 user message (含 metadata.workbench)
```

### 3.2 Direct Routing（@agent）

```
@agent mention → resolveDirectRouting()
  → useAgent 先写 optimistic user message（带 directRoutingDelivery）
  → ipc.invoke('swarm:send-user-message', {sessionId, messageId, timestamp, metadata})
    → swarm.ipc.ts
      → buildPersistedUserMessage()
      → sessionManager.addMessageToSession()  // 先持久化
      → 持久化成功 → teammateService.onUserMessage() + swarmEventEmitter.userMessage()
      → 持久化失败 → 返回 {delivered: false, persisted: false}
  ← renderer 回滚 optimistic message，明确提示未写入
```

**要点**：renderer 的 optimistic 只是体验优化，主进程持久化才是真相源。持久化成功是 fanout 的前提。

### 3.3 Turn Timeline 投影

```
messages + metadata.workbench
  + useWorkbenchCapabilities()     ← live capability state
  + useSwarmStore()                ← parallel routing evidence
  + turnExecutionStore             ← auto routing evidence + direct live buffer

  → useTurnProjection()            ← 只切 turn（保持纯净）
  → useTurnExecutionClarity()      ← enrichment: 注入 4 类 timeline node
  → TraceNodeRenderer              ← 渲染 turn_timeline 节点
```

`turnExecutionStore` 是一个很小的 renderer-only ephemeral buffer，不做持久化。它承担 live execution clarity，不是 Direct routing 的唯一事实来源（那个是 `metadata.directRoutingDelivery`）。

## 4. 与 TaskPanel / SwarmMonitor 的分工

| 面板 | 承担什么 | 不承担什么 |
|------|----------|-------------|
| **聊天主链路（workbench）** | 当前 turn 的选择、blocked reason、routing evidence、artifact ownership | 全量 debug console、历史 swarm trace、完整 agent lifecycle 面板 |
| **TaskPanel** | workspace/skills/connectors/MCP 的深度管理、capability detail sheet、swarm orchestration | 不再作为默认心智入口。聊天能完成的动作，不要求先打开 TaskPanel |
| **SwarmMonitor** | agent run 详情、run aggregation、SwarmTraceHistory | 不反向作为 turn-level 解释源 |
| **Eval Center** | Replay、failure attribution、跨 session 复盘 | 不独立维护 trace identity，和主产品共享同一 `session:<sessionId>` |

**禁止事项**：

1. 聊天主链路和 TaskPanel 不能各算一套 `blocked reason` 或 `artifact owner`；必须复用 `workbenchBlockedReasons.ts` / `artifactOwnership.ts`。
2. TaskPanel 复用聊天 turn timeline 时，只复用 DTO 和纯 builder，不复用聊天 React 组件。
3. 任何 `auto routing` 证据必须经 main process 的结构化 `routing_resolved` 事件，不允许 renderer 解析 notification 文案。

### 4.1 右侧 sidecar 物理整合（v0.16.60-65）

**职责分工不变，物理宿主统一**：TaskPanel / SkillsPanel / FileExplorerPanel / PreviewPanel 共享同一右侧面板宿主，由 `WorkbenchTabs` 顶栏切换，不再各自独立抢宽度。

| 层 | 位置 | 说明 |
|----|------|------|
| Store | `src/renderer/stores/appStore.ts` | `activeWorkbenchTab: 'task' \| 'skills' \| 'files' \| null` + `previewTabs: PreviewTab[]`（独立 LRU 注册表，`MAX_PREVIEW_TABS = 8`） |
| Action | `appStore.openWorkbenchTab(id)` / `closeWorkbenchTab(id)` | 单一入口；legacy `show*Panel` 已迁移完成并移除 |
| 顶栏 | `src/renderer/components/WorkbenchTabs.tsx` | tab bar，X 关闭后切到幸存 tab |
| 宿主 | `src/renderer/App.tsx` | 按 `activeWorkbenchTab` 条件渲染 Task/Skills/Files，`isPreviewActive` 并行渲染 Preview |

**解读**：这一轮不改 ADR-011 定义的主链路语义，只解决 sidecar 的信息架构问题——此前 Task/Skills/Preview/Files 各有独立 toggle（CloudTaskToggle / TaskListToggle / DAGToggle / ObservabilityToggle），多开时互相挤压、心智成本高。整合后右侧只有一个面板位，用户选哪个 tab 它就渲染哪个。

**死代码清理**：与此同步移除 `CloudTaskToggle` / `TaskListToggle` / `DAGToggle` / `ObservabilityToggle` 及 orphan state；TitleBar 只保留 File / Skills / Task 三个 toggle 入口。

## 5. 落点地图（看 workbench 从哪里入）

### 5.1 Contract 层

- `src/shared/contract/conversationEnvelope.ts` — 发送外壳 + user message metadata 投影
- `src/shared/contract/message.ts` — `MessageMetadata.workbench`
- `src/shared/contract/turnTimeline.ts` — turn 内解释节点 DTO
- `src/shared/contract/sessionWorkspace.ts` — session 维度 workbench provenance
- `src/shared/contract/reviewQueue.ts` — review/replay 回流契约
- `src/shared/contract/trace.ts` — 扩展 `swarm_launch_request` / `turn_timeline` 节点类型

### 5.2 Main Process

- `src/main/app/agentAppService.ts` — envelope → orchestrator 接入点
- `src/main/app/workbenchTurnContext.ts` — turn 维度 workbench context 组装
- `src/main/agent/agentOrchestrator.ts` — `sendMessage / interruptAndContinue` 接 `messageMetadata`；发出结构化 `routing_resolved` 事件
- `src/main/ipc/agent.ipc.ts` — `normalizeEnvelope()` 兼容 legacy payload
- `src/main/ipc/swarm.ipc.ts` — `swarm:send-user-message` 持久化先于 fanout
- `src/main/tools/workbenchToolScope.ts` — 当前 turn capability 硬作用域
- `src/main/tools/vision/browserWorkbenchIntent.ts` — browser/desktop workbench intent
- `src/main/evaluation/reviewQueueService.ts` — Review Queue 持久化
- `src/main/evaluation/telemetryQueryService.ts` — trace identity + replay fallback

### 5.3 Renderer

- `src/renderer/stores/composerStore.ts` — 发送前临时上下文选择
- `src/shared/contract/workbenchPreset.ts` / `src/renderer/stores/workbenchPresetStore.ts` — 命名 preset/recipe 契约 + 本地 preset 资产库
- `src/renderer/stores/turnExecutionStore.ts` — turn 维度 ephemeral routing evidence buffer
- `src/renderer/hooks/useAgent.ts` — envelope 发送链 + direct routing 解析
- `src/renderer/hooks/useTurnProjection.ts` — turn 基础切分
- `src/renderer/hooks/useTurnExecutionClarity.ts` — turn timeline enrichment
- `src/renderer/hooks/useWorkbenchCapabilities.ts` / `useWorkbenchInsights.ts` — 共享 capability 模型
- `src/renderer/utils/turnTimelineProjection.ts` — 4 类 timeline node 的构造规则
- `src/renderer/utils/workbenchCapabilityRegistry.ts` / `workbenchQuickActions.ts` — capability registry + 最短路径动作
- `src/renderer/utils/workbenchBlockedReasons.ts` / `artifactOwnership.ts` — 共享 builder（跨聊天/TaskPanel 复用）
- `src/renderer/components/features/chat/InlineWorkbenchBar.tsx` — 输入框上方能力栏
- `src/renderer/components/features/chat/SessionWorkspaceBar.tsx` — 当前 session 的 workspace / provenance 条
- `src/renderer/components/features/swarm/LaunchRequestCard.tsx` — 聊天内联启动卡（TaskPanel 与 trace 共用）
- `src/renderer/components/workbench/WorkbenchCapabilitySheetLite.tsx` — 统一 capability detail sheet
- `src/renderer/components/features/chat/TraceNodeRenderer.tsx` — 新增 `turn_timeline` 节点渲染

### 5.4 测试锚点

- `tests/renderer/stores/composerStore.test.ts`
- `tests/renderer/stores/turnExecutionStore.test.ts`
- `tests/renderer/hooks/useTurnExecutionClarity.test.ts`
- `tests/renderer/utils/turnTimelineProjection.test.ts`
- `tests/renderer/utils/workbenchCapabilityRegistry.test.ts`
- `tests/renderer/utils/workbenchQuickActions.test.ts`
- `tests/renderer/components/traceNodeRenderer.launchRequest.test.ts`
- `tests/unit/ipc/swarm.ipc.test.ts`
- `tests/unit/evaluation/telemetryQueryService.test.ts`
- `tests/unit/evaluation/reviewQueueService.test.ts`
- `tests/e2e/review-queue.e2e.spec.ts`

## 6. Backlog（不在当前产品口径内）

下列项目**明确还没产品化**。要在 PRD 里提 workbench 能力时，不要把它们写成"已完成"。

1. **Connector lifecycle 管理面**：native connector 已有 `enable / retry / explicit probe / repair permissions / disconnect / remove` 最小闭环、设置页 lifecycle 按钮和 toolScope gate。还没做非 native connector 路径、完整权限修复向导和跨 connector 的统一管理面。skill 挂载 / MCP 重连的最短路径动作已落，但不等于所有 capability 生命周期完成。
2. **Failure-to-Capability 资产沉淀**：当前失败会话能写入 `failure_followup` sink，并按 `skill / dataset / prompt-policy / capability-health` 写入分流 metadata 回到 Review Queue，同时生成本地 `failureAsset` draft。但还没做 richer triage、批量处理、asset apply/export 和归因后的真实资产流转。
3. **命名 preset / recipe 资产库**：已有 `historical session → current session` 的 workbench reuse，也已有本地命名 preset 的保存和应用；recipe contract/store 已支持从 presets 生成、hydrate、upsert、delete、list。还没做 recipe 管理 UI / 多步执行编排、搜索/分享/版本化管理，preset UI 也仍停在 Sidebar 右键菜单的最小入口。
4. **Browser/Desktop readiness 与 artifact consistency**：browser/desktop 已有显式 mode 区分、基础 readiness 展示和有限 smoke。剩余是权限修复路径、collector 状态一致性、artifact 展示/恢复一致性，以及更完整的验收覆盖。
5. **Long-session robustness**：长会话 trace 渲染、capability registry 派生开销、TaskPanel + 聊天区双渲染的重复成本，未专门优化。

当前优先单独开题的是 1 的非 native/统一管理面、2 的 triage / asset apply，以及 3 的 recipe 管理 UI / 执行编排。browser/desktop 只按 readiness 与 artifact consistency backlog 滚动补，不新开 Browser Use / Computer Use phase。

## 7. 常见误解

- **"workbench 是重写 swarm 引擎"** — 不是。Workbench 不改 `CoworkContract / launch builder / swarm runtime`，只改它们的产品暴露方式。
- **"Direct routing 是 renderer-only 短路"** — 不是。renderer 先写 optimistic，但主进程 `swarm:send-user-message` 会先持久化再 fanout。失败回滚，不假装成功。
- **"Auto routing 靠解析 notification 文案"** — 不是。主进程发出结构化 `routing_resolved` 事件，renderer 写进 `turnExecutionStore`。
- **"Phase 1-6 都还没开始"** — 错。Phase 1-2 已关账，Phase 3 有基础骨架、native connector 最小 lifecycle 和设置页入口；Phase 4/5 已有最小闭环；Phase 6.1/6.2 已落，6.3/6.4 有 failure asset draft、preset 资产化和 recipe store。剩下的是 backlog，不是主实现。

## 8. 外部参考

- 设计稿（保留原始切法）：`docs/plans/2026-04-16-chat-native-agent-workbench-plan.md`
- Phase 1 实施规格：`docs/plans/2026-04-16-phase1-chat-native-workbench-implementation-spec.md`
- Phase 2 实施规格：`docs/plans/2026-04-17-phase2-execution-clarity-implementation-spec.md`
- 下一阶段路线图：`docs/plans/2026-04-17-chat-native-workbench-next-phase-roadmap.md`
- Accio 对标分析：`docs/analysis/2026-04-16-accio-vs-code-agent-core-differences.md`
- 决策记录：[ADR-011](../decisions/011-chat-native-workbench.md)

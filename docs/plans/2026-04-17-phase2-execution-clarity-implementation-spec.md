# Phase 2 执行清晰度实施规格

日期：2026-04-17  
状态：已完成（已按 2026-04-26 代码/测试对齐）
关联路线图：[2026-04-17-chat-native-workbench-next-phase-roadmap.md](/Users/linchen/Downloads/ai/code-agent/docs/plans/2026-04-17-chat-native-workbench-next-phase-roadmap.md)  
关联设计：[2026-04-16-chat-native-agent-workbench-plan.md](/Users/linchen/Downloads/ai/code-agent/docs/plans/2026-04-16-chat-native-agent-workbench-plan.md)  
关联实施：[2026-04-16-phase1-chat-native-workbench-implementation-spec.md](/Users/linchen/Downloads/ai/code-agent/docs/plans/2026-04-16-phase1-chat-native-workbench-implementation-spec.md)  
关联分析：[2026-04-16-accio-vs-code-agent-core-differences.md](/Users/linchen/Downloads/ai/code-agent/docs/analysis/2026-04-16-accio-vs-code-agent-core-differences.md)

## 0. 当前完成定义（2026-04-18）

这份文档保留 `2026-04-17` 的 slice 拆法，但当前关账口径要按已落代码重读。

- `turn timeline` 已落为 `workbench_snapshot + capability_scope + routing_evidence + artifact_ownership` 这条最小执行解释链。
  - 证据：`src/shared/contract/turnTimeline.ts`、`src/renderer/utils/turnTimelineProjection.ts`、`tests/renderer/hooks/useTurnExecutionClarity.test.ts`
- `Direct` routing evidence 不再只靠 live ephemeral buffer；runtime event 在时会优先用，消失后会从持久化 `metadata.directRoutingDelivery` 回放重建。
  - 证据：`src/renderer/utils/turnTimelineProjection.ts`、`tests/renderer/hooks/useTurnExecutionClarity.test.ts`
- `Auto` routing 现在已有主进程发出的结构化 `routing_resolved` 事件，再由 renderer 写入 `turnExecutionStore`，不再只解析 notification 文案。
  - 证据：`src/shared/contract/agent.ts`、`src/main/agent/agentOrchestrator.ts`、`src/renderer/hooks/useAgent.ts`、`src/renderer/stores/turnExecutionStore.ts`
- `blocked capability` 当前产品边界是：skill / MCP 可以在统一 sheet 里走最短路径动作，但 connector 只展示真实 blocked reason / hint，没有一键 `connect / retry` 闭环。
  - 证据：`src/renderer/utils/workbenchCapabilityRegistry.ts`、`src/renderer/utils/workbenchQuickActions.ts`、`src/renderer/components/workbench/WorkbenchCapabilitySheetLite.tsx`、`tests/renderer/utils/workbenchQuickActions.test.ts`、`tests/renderer/utils/workbenchCapabilityRegistry.test.ts`
- 因此下面凡是把 `direct` 写成“只在 renderer 本地短路”或把 `auto` 写成“只有 notification”的地方，都应理解为原始假设，不是当前代码状态。

## 0.1 2026-04-26 状态补丁

Phase 2 的 `execution clarity projection` 已被后续几批提交继续扩展，当前不只解释 routing / blocked capability / artifact owner：

- Semantic Tool UI 已把 `_meta.shortDescription` 从 schema 注入、provider parser、SessionRepository fallback 到 ToolCall UI 打通，聊天里的工具标题、目标、引用和 URL chip 更接近语义层展示。
- Browser / Computer tool call 的 action preview、trace id、风险标签、脱敏摘要已经进入 `ToolCallDisplay` / grouped tool step，而不是只靠底层 tool payload。
- Activity Providers 把 OpenChronicle、Tauri Native Desktop、audio、screenshot-analysis 汇入统一 `ActivityContext`，prompt 注入由 formatter 处理。
- Eval / Replay 侧已补 SSE progress、fatal error 熔断、DB 去重、真实 multi-turn history、recent memory 隔离和 `max_tool_calls` weighted scoring；这些会影响 execution clarity 的回放和验收口径。

## 1. 结论

Phase 2 的最佳切点不是继续往 `TaskPanel`、`Orchestration` 或 `SwarmMonitor` 塞更多 UI，而是先在聊天 turn 内建立一层窄而稳定的 `execution clarity projection`。

这轮只做 4 个 slice：

1. `turn timeline node contract`
2. `blocked capability reason model`
3. `routing evidence projection`
4. `artifact ownership projection`

和 roadmap 相比，这里有 3 个明确调整：

1. `projectTurns()` 继续只负责“按消息切 turn”，不把它改成一个读多 store 的大总管；Phase 2 新增一层 enrichment hook 来补执行清晰度。
2. `blocked capability` 本轮先落 `reason model + passive hint`，不在聊天区直接做 `connect / mount / authorize` 动作按钮；那些属于 `Unified capability lifecycle`，应放到下一阶段。
3. `artifact ownership` 先只投影聊天主链路里能可靠归因的产物，不把 `TaskPanel/Orchestration/SwarmMonitor` 里的 swarm 详情硬搬进聊天区。

## 2. 目标、成功标准、非目标

### 2.1 目标

让用户在聊天主链路里看清 4 件事：

1. 这一 turn 实际带了什么 workbench 上下文
2. 这轮有哪些已选 capability 其实处于 blocked 状态
3. 这轮 routing 最终怎么落地了
4. 这轮留下了哪些输出，以及是谁产出的

### 2.2 成功标准

- 用户不打开 `TaskPanel`，也能在 turn 内看懂“选了什么、谁接手了、哪些没用上、产出了什么”。
- `selected but blocked` 不再只表现为 dimmed pill，而是有统一 reason code、文案和 hint。
- `routing` 不再只停留在 `metadata.workbench.routingMode`；`auto / direct / parallel` 都有执行证据。
- turn 下方能看到聊天主链路可归因的 `file / artifact / link / note` 摘要。
- 旧消息、旧 trace、旧 `swarm_launch_request` 节点都继续可渲染。

### 2.3 非目标

这轮不做：

- 新 capability 入口
- swarm 引擎重写
- settings 信息架构重做
- `TaskPanel` 的大改版
- `Orchestration` timeline 和 `SwarmMonitor` 的聊天化迁移
- capability lifecycle 动作按钮（`connect / mount / authorize / retry`）
- 完整 swarm run 与聊天 turn 的持久化关联

## 3. 当前架构约束

### 3.1 turn trace 仍然是 renderer 侧投影，不是统一执行事件流

- `src/renderer/hooks/useTurnProjection.ts` 目前只看 `messages + pending launchRequests`。
- `src/shared/contract/trace.ts` 只支持 `user / assistant_text / tool_call / system / swarm_launch_request`。
- `approved/rejected launch`、`auto routing`、`toolScope deny`、artifact owner 都没有统一 node contract。

### 3.2 capability 状态是 session-scoped，共享了状态但没共享“这一 turn 的解释”

- `src/renderer/hooks/useWorkbenchCapabilities.ts` 已统一 `skills / connectors / mcp` 的可见和状态。
- `src/renderer/hooks/useWorkbenchInsights.ts` 是 session 维度的 `references / history` 聚合，不知道某个 turn 该显示什么解释节点。
- `src/renderer/components/features/chat/InlineWorkbenchBar.tsx` 现在只有 selected/dimmed，没有 blocked reason model。

### 3.3 routing 证据分散在 3 条链路里

- `src/renderer/hooks/useAgent.ts` 里 `direct` 仍由 renderer 触发，但消息不会只停在 renderer；当前会带着 `messageId + metadata` 进入主进程 session 持久化链。
- `src/main/agent/agentOrchestrator.ts` 现在已发出结构化 `routing_resolved` 事件，renderer 会把它写进 `turnExecutionStore`。
- `parallel` 的真实证据在 `src/renderer/stores/swarmStore.ts` 的 `launchRequests + eventLog`，聊天 trace 只投了 pending launch。

### 3.4 artifact 与 ownership 也是分裂的

- `src/renderer/hooks/useStatusRailModel.ts` 只提 session 级文件产物，不带 owner，也不按 turn。
- `src/main/agent/runtime/messageProcessor.ts` 会给 assistant message 提取 `artifacts`，但聊天 trace 没把 owner 概念投出来。
- `src/shared/contract/swarm.ts` 里的 `filesChanged / resultPreview` 只活在 swarm 侧 UI，没有稳定的 turn join key。

### 3.5 TaskPanel 已经是 sidecar，不该在这一轮重新变成主入口

- `src/renderer/components/TaskPanel/TaskMonitor.tsx` 依赖 `useStatusRailModel + useWorkbenchInsights`。
- `src/renderer/components/TaskPanel/Orchestration.tsx` 和 `src/renderer/components/features/swarm/SwarmMonitor.tsx` 已经有自己的 timeline / swarm 细节表达。
- Phase 2 应该复用它们已有的数据源，不反向把聊天主链路做成 sidecar 的镜像。

## 4. Slice 1: turn timeline node contract

### 4.1 目标

给 turn trace 增加一层稳定的 timeline node contract，让后面的 blocked reason、routing evidence、artifact ownership 都走同一条投影路径，而不是各自往 `TraceNodeRenderer` 里塞分支。

### 4.2 核心决策

新增一个共享 contract 文件，例如 `src/shared/contract/turnTimeline.ts`，定义：

```ts
export type TurnTimelineNodeKind =
  | 'workbench_snapshot'
  | 'blocked_capabilities'
  | 'routing_evidence'
  | 'artifact_ownership';

export interface TurnTimelineNode {
  id: string;
  kind: TurnTimelineNodeKind;
  timestamp: number;
  tone: 'neutral' | 'info' | 'warning' | 'success' | 'error';
}
```

`TraceNode` 只新增一种新的 wrapper node：

```ts
type TraceNodeType =
  | 'user'
  | 'assistant_text'
  | 'tool_call'
  | 'system'
  | 'swarm_launch_request'
  | 'turn_timeline';
```

这样做的原因：

- `TraceNodeRenderer` 只新增一个入口，不会被 4 个 slice 各加一遍类型分支。
- `projectTurns()` 仍然专注“切 turn”，新建一层 `useTurnExecutionClarity()` 做 enrichment。
- 后面如果要把部分节点复用到 `TaskPanel`，复用的是 timeline payload，不是聊天组件实现。

### 4.3 节点顺序

同一 turn 内按这个顺序插入：

1. `user`
2. `turn_timeline(workbench_snapshot)`
3. `turn_timeline(blocked_capabilities)`，仅当存在 blocked 项
4. 现有 `assistant_text / tool_call / swarm_launch_request`
5. `turn_timeline(routing_evidence)`，仅当出现执行证据
6. `turn_timeline(artifact_ownership)`，作为当前 turn 的尾部摘要

### 4.4 file-level 改动清单

- 新增 `src/shared/contract/turnTimeline.ts`
- 修改 `src/shared/contract/trace.ts`
- 修改 `src/shared/contract/index.ts`
- 新增 `src/renderer/hooks/useTurnExecutionClarity.ts`
- 新增 `src/renderer/utils/turnTimelineProjection.ts`
- 修改 `src/renderer/components/ChatView.tsx`
- 修改 `src/renderer/components/features/chat/TraceNodeRenderer.tsx`
- 新增 `tests/renderer/hooks/useTurnExecutionClarity.test.ts`
- 修改 `tests/renderer/components/traceNodeRenderer.launchRequest.test.ts`

## 5. Slice 2: blocked capability reason model

### 5.1 目标

把“选中了但当前其实用不上”的 capability 统一归一成 reason model，并投影回聊天 turn。

### 5.2 reason model

先定义一组窄而稳定的 reason code：

```ts
type BlockedCapabilityReasonCode =
  | 'skill_not_mounted'
  | 'skill_missing'
  | 'connector_disconnected'
  | 'mcp_disconnected'
  | 'mcp_error'
  | 'scope_empty'
  | 'reserved_browser_session_required'
  | 'reserved_desktop_permission_required';
```

其中这轮真正落地的只有：

- `skill_not_mounted`
- `skill_missing`
- `connector_disconnected`
- `mcp_disconnected`
- `mcp_error`

`browser_session_required / desktop_permission_required` 先保留 code，不接 UI，不扩 capability 入口。

### 5.3 投影规则

blocked reason 只看“当前 turn 选中的 capability”：

- user message 的 `metadata.workbench.selectedSkillIds / selectedConnectorIds / selectedMcpServerIds`
- 当前 live capability state：`useWorkbenchCapabilities()`

生成结果示例：

- `Skill jira 已安装但未挂载，本轮不会调用`
- `Connector mail 当前未连接，本轮不会调用`
- `MCP github 当前状态 error，本轮不会调用`

这里故意不做 action button，只做 `reason + next-step hint`，例如：

- `去 TaskPanel/Skills 挂载`
- `先在本地应用里完成授权/可用性检查，再重新发送`
- `去 MCP Settings 排查`

原因很直接：当前产品没有 connector 的一键 `connect / retry` 闭环；如果把 connector 写成“点一下就能修好”，文档会误导。skill 挂载 / MCP 重连这些最短路径动作已经在统一 sheet 里存在，但它们不等于 connector lifecycle 已完成。

### 5.4 file-level 改动清单

- 修改 `src/shared/contract/turnTimeline.ts`
- 新增 `src/renderer/utils/workbenchBlockedReasons.ts`
- 修改 `src/renderer/utils/turnTimelineProjection.ts`
- 修改 `src/renderer/hooks/useTurnExecutionClarity.ts`
- 修改 `src/renderer/components/features/chat/TraceNodeRenderer.tsx`
- 修改 `src/renderer/utils/workbenchPresentation.ts`
- 新增 `tests/renderer/utils/workbenchBlockedReasons.test.ts`
- 修改 `tests/renderer/hooks/useTurnExecutionClarity.test.ts`

## 6. Slice 3: routing evidence projection

### 6.1 目标

把 `Auto / Direct / Parallel` 从“发送前意图”推进到“发送后证据”。

### 6.2 核心决策

这一块不靠解析通知文案，也不靠重写 swarm trace；只补一条极窄的结构化事件链。

#### Direct

当前实现里，`Direct` 不是只留一条 ephemeral evidence，而是走“双层证据”：

- live path：`src/renderer/hooks/useAgent.ts` 在发送成功后写入 `turnExecutionStore`，用于当前会话的即时解释
- persisted path：同一条 user message 会把 `directRoutingDelivery` 写进 `metadata.workbench`；`turnTimelineProjection` 在 live event 消失后，仍能从持久化 metadata 回放出 `delivered / missing` 证据

因此 `Direct` 的当前完成定义是：

- requested targets
- delivered targets
- missing targets（如果有）
- replay fallback（runtime event 消失后仍能看回去）

#### Auto

这条链现在已经不是“只有 notification”。

当前主进程会发出结构化事件：

```ts
{
  type: 'routing_resolved',
  data: { mode: 'auto', agentId, agentName, reason, score, fallbackToDefault }
}
```

renderer 不再解析字符串，而是把这条事件写进一个很小的 session-scoped buffer。

#### Parallel

不改 swarm runtime，直接消费现有：

- `useSwarmStore().launchRequests`
- `useSwarmStore().eventLog`

聊天 trace 只需要把同一 turn 相邻时间窗口里的这些信息压成一条 `routing_evidence`：

- `launch_requested`
- `launch_approved`
- `launch_rejected`
- `swarm_started`

### 6.3 为什么要引入一个很小的 ephemeral turn buffer

当前这个 buffer 仍然需要保留，但用途已经更窄：

- `auto`：结构化 evidence 走 `routing_resolved -> turnExecutionStore`
- `direct`：live 仍记 buffer，但 replay 时优先靠持久化 metadata

也就是说，它现在主要是 live execution clarity 的补层，不再承担 `Direct` 的唯一事实来源。

因此这里允许新增一个极小的 renderer store，例如 `src/renderer/stores/turnExecutionStore.ts`：

- 只存当前 session 的 turn-level live routing evidence
- 不做持久化
- 不存完整 swarm trace
- 只为聊天主链路 projection 服务

### 6.4 file-level 改动清单

- 修改 `src/shared/contract/agent.ts`
- 修改 `src/shared/contract/turnTimeline.ts`
- 修改 `src/main/agent/agentOrchestrator.ts`
- 新增 `src/renderer/stores/turnExecutionStore.ts`
- 修改 `src/renderer/hooks/useAgent.ts`
- 修改 `src/renderer/utils/turnTimelineProjection.ts`
- 修改 `src/renderer/hooks/useTurnExecutionClarity.ts`
- 修改 `src/renderer/components/features/chat/TraceNodeRenderer.tsx`
- 新增 `tests/renderer/stores/turnExecutionStore.test.ts`
- 修改 `tests/renderer/hooks/useTurnExecutionClarity.test.ts`

## 7. Slice 4: artifact ownership projection

### 7.1 目标

让 turn 末尾能看到“这轮留下了什么”，并且带最小 owner 语义。

### 7.2 ownership model

先定义一个窄模型：

```ts
type TurnArtifactKind = 'file' | 'artifact' | 'link' | 'note';
type TurnArtifactOwnerKind = 'assistant' | 'tool' | 'agent';

interface TurnArtifactOwnershipItem {
  kind: TurnArtifactKind;
  label: string;
  ownerKind: TurnArtifactOwnerKind;
  ownerLabel: string;
  path?: string;
  url?: string;
  sourceNodeId?: string;
}
```

### 7.3 Phase 2 只覆盖聊天主链路里可可靠归因的产物

这轮只提这 3 类来源：

1. 当前 turn 的 `assistantMessage.artifacts`
2. 当前 turn 的 `toolCalls[].result.outputPath`
3. 当前 turn 的 `toolCalls[].result.metadata.filePath/imagePath/videoPath/outputPath`

owner 规则：

- assistant message 自带 artifact：`ownerKind = 'assistant'`
- tool result 产出的文件：`ownerKind = 'tool'`，`ownerLabel = tool name`
- 如果这一 turn 已有 direct/auto routing evidence，可在展示文案里补一个上层 owner，例如 `reviewer · Edit`

### 7.4 明确先不做的 ownership

这轮先不把下面这些内容回灌进聊天区：

- `SwarmAgentState.filesChanged`
- `SwarmAggregation.filesChanged`
- `CompletedAgentRun.resultPreview`
- `SwarmTraceHistory` 里的历史 run 产物

原因不是这些数据没价值，而是当前没有稳定的 `turn <-> swarm run` join key。  
如果现在强接，会很容易把别的 run 的输出错贴到当前 turn。

### 7.5 file-level 改动清单

- 修改 `src/shared/contract/turnTimeline.ts`
- 新增 `src/renderer/utils/artifactOwnership.ts`
- 修改 `src/renderer/utils/turnTimelineProjection.ts`
- 修改 `src/renderer/hooks/useTurnExecutionClarity.ts`
- 修改 `src/renderer/components/features/chat/TraceNodeRenderer.tsx`
- 新增 `tests/renderer/utils/artifactOwnership.test.ts`
- 修改 `tests/renderer/hooks/useTurnExecutionClarity.test.ts`

## 8. shared contract、renderer hooks、trace projection、TaskPanel 的关系

### 8.1 唯一共享边界：`turnTimeline.ts`

`src/shared/contract/turnTimeline.ts` 是这轮新增的唯一共享 payload 层：

- 它定义 blocked reason、routing evidence、artifact ownership 的 shape
- renderer hook 和 trace renderer 都只认这套 DTO
- 以后如果 `TaskPanel` 要复用，只复用 DTO 和纯 builder，不复用聊天组件

### 8.2 renderer hooks 分工

- `useTurnProjection()`：继续只做 `messages -> TraceTurn[]` 的基础切分
- `useTurnExecutionClarity()`：消费 `TraceTurn[] + useWorkbenchCapabilities() + useSwarmStore() + turnExecutionStore`，补 timeline nodes
- `useWorkbenchInsights()`：继续服务 session-sidecar 的 `references/history`，不被强行改成 turn-scoped

### 8.3 trace projection 分工

聊天主链路的最终数据流是：

`messages + metadata.workbench + live capabilities + swarm launch/event log + ephemeral routing evidence`

`-> useTurnProjection()`

`-> useTurnExecutionClarity()`

`-> TraceNodeRenderer`

### 8.4 TaskPanel 的定位

`TaskPanel` 在 Phase 2 不变成主消费者：

- `TaskMonitor.tsx` 继续用 `useStatusRailModel + useWorkbenchInsights`
- `Orchestration.tsx` 继续吃 `swarmStore.launchRequests / eventLog`
- `SwarmMonitor.tsx` 继续吃 `swarmStore` 的 agent/run 细节

唯一的约束是：

如果后续 `TaskPanel` 也要展示 blocked reason 或 artifact owner，必须复用：

- `src/renderer/utils/workbenchBlockedReasons.ts`
- `src/renderer/utils/artifactOwnership.ts`

不能再各算一套。

## 9. 验证方案、回归风险、兼容策略

### 9.1 验证方案

单元测试：

- `tests/renderer/hooks/useTurnExecutionClarity.test.ts`
  - snapshot node 顺序
  - blocked capability node 只在 selected-and-blocked 时出现
  - routing evidence 能合并 direct/auto/parallel 三类来源
  - artifact ownership 只抽当前 turn
- `tests/renderer/utils/workbenchBlockedReasons.test.ts`
- `tests/renderer/utils/artifactOwnership.test.ts`
- `tests/renderer/stores/turnExecutionStore.test.ts`

组件测试：

- 修改 `tests/renderer/components/traceNodeRenderer.launchRequest.test.ts`
  - 保留 launch request 渲染
  - 新增 timeline node 渲染断言

定向手测：

1. 选中未挂载 skill 后发送，turn 里出现 blocked reason
2. 选中断开的 connector/MCP 后发送，turn 里出现 blocked reason
3. `Direct` 指定 agent，turn 里出现 delivered targets
4. `Auto` 命中特定 agent，turn 里出现 route evidence，而不是只有 metadata
5. `Parallel` 触发 launch request，聊天区能看到 pending -> approved/rejected
6. 当前 turn 调用 `Write/Edit/image_generate` 等工具后，turn 尾部出现 artifact ownership 摘要

### 9.2 回归风险

- `useTurnProjection()` 被塞太多职责，导致 turn 切分逻辑回归  
  缓解：保持 `useTurnProjection()` 纯切分，clarity enrichment 放到新 hook。

- `auto routing` 证据与 turn 错配  
  缓解：只在“每 session 同时只有一个 active non-direct turn”假设下做最近 turn 绑定；若无可绑定 turn，则丢弃 evidence，不强贴。

- `parallel` evidence 重复  
  缓解：按 `launchRequest.id + event type` 去重，不直接把整个 `eventLog` 平铺进聊天。

- artifact ownership 错把旧 turn 产物带进来  
  缓解：只扫描当前 turn 的 assistant/tool nodes，不扫全 session。

### 9.3 兼容策略

- 没有 `turn_timeline` 数据的旧会话仍按原 trace 渲染。
- 旧的 `swarm_launch_request` 节点继续保留，Phase 2 只是补它后面的 resolved evidence。
- `notification` 文案在过渡期可以继续发，但 renderer 不再依赖它。
- `TaskPanel / Orchestration / SwarmMonitor` 不需要同步改版即可继续工作。
- `reserved_browser_session_required / reserved_desktop_permission_required` 只保留 contract，不强行在这轮接 UI。

## 10. 哪些只先做聊天主链路投影，哪些先不碰

### 10.1 这轮只先做聊天主链路投影

- `src/renderer/components/ChatView.tsx`
- `src/renderer/hooks/useTurnExecutionClarity.ts`
- `src/renderer/utils/turnTimelineProjection.ts`
- `src/renderer/components/features/chat/TraceNodeRenderer.tsx`
- `src/renderer/stores/turnExecutionStore.ts`
- `src/shared/contract/turnTimeline.ts`

### 10.2 这轮明确先不碰

- `src/renderer/components/TaskPanel/TaskMonitor.tsx`
- `src/renderer/components/TaskPanel/Connectors.tsx`
- `src/renderer/components/TaskPanel/Skills.tsx`
- `src/renderer/components/TaskPanel/Orchestration.tsx`
- `src/renderer/components/features/swarm/SwarmMonitor.tsx`
- `src/renderer/components/features/swarm/SwarmTraceHistory.tsx`
- swarm runtime / orchestrator / launch approval core logic

允许的唯一例外是：

- `src/main/agent/agentOrchestrator.ts` 为 `auto routing` 补结构化 evidence event

这不是 swarm 重写，只是给聊天主链路补可解释性信号。

## 11. 实施顺序

建议按这个顺序落地，避免前后返工：

1. 先加 `turnTimeline.ts + useTurnExecutionClarity()`，让 trace 能接新的 node 类型
2. 再接 `blocked capability reason model`
3. 然后接 `routing evidence projection`
4. 最后补 `artifact ownership projection`

这样每个 slice 都能单独验，而且不会因为后面的 routing/artifact 需求反向推翻最前面的 contract。

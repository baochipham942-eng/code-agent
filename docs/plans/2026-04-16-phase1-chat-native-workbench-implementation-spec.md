# Phase 1 Chat-Native Workbench 实施规格

日期：2026-04-16  
状态：已完成（已按 2026-04-26 代码/测试对齐）
关联设计：[2026-04-16-chat-native-agent-workbench-plan.md](/Users/linchen/Downloads/ai/code-agent/docs/plans/2026-04-16-chat-native-agent-workbench-plan.md)  
关联分析：[2026-04-16-accio-vs-code-agent-core-differences.md](/Users/linchen/Downloads/ai/code-agent/docs/analysis/2026-04-16-accio-vs-code-agent-core-differences.md)

## 0. 当前完成定义（2026-04-18）

这份文档保留 `2026-04-16` 的实施切法，但当前关账口径要按已落代码重读。

- `ConversationEnvelope`、`metadata.workbench`、`composerStore` 已进入真实发送链。
  - 证据：`src/renderer/stores/composerStore.ts`、`src/renderer/hooks/useAgent.ts`、`tests/renderer/stores/composerStore.test.ts`
- 聊天区已能渲染 workbench routing/capability badge 和内联 `LaunchRequestCard`。
  - 证据：`tests/renderer/components/traceNodeRenderer.launchRequest.test.ts`
- `Direct routing` 的完成定义已经不是“UI 意图写进 metadata”这么窄，而是：
  1. renderer 先写 optimistic user message；
  2. 主进程 `swarm:send-user-message` 先把这条 user message 持久化进当前 session；
  3. 持久化成功后才 fanout 给目标 agent；
  4. 非重复写入失败时，renderer 会回滚这条 optimistic message；
  5. 历史重载 / Replay / Eval Center 可通过持久化 metadata 与 replay fallback 重建这条链。
  - 证据：`src/renderer/hooks/useAgent.ts`、`src/main/ipc/swarm.ipc.ts`、`src/main/services/core/repositories/SessionRepository.ts`、`src/renderer/utils/turnTimelineProjection.ts`、`src/main/evaluation/telemetryQueryService.ts`、`tests/unit/ipc/swarm.ipc.test.ts`、`tests/unit/evaluation/telemetryQueryService.test.ts`、`tests/renderer/hooks/useTurnExecutionClarity.test.ts`
- 因此下面凡是把 `routing` 写成“纯 UI 意图”的地方，都应理解为原始切边界；当前真实状态里，`Auto / Parallel` 仍以意图 + evidence 为主，但 `Direct` 已经是真发送链。

## 0.1 2026-04-26 状态补丁

Phase 1 的核心边界仍成立：聊天发送链以 `ConversationEnvelope` 携带工作台上下文。但上层入口已经被后续 B+ IA 调整，不应再把早期 UI 截面当成当前产品形态：

- ChatInput 保留高频发送动作；低频动作进入 `InputAddMenu`，Code / Plan / Ask 也收进 `+`。
- 模型与 effort 合并成一个胶囊；Routing / Browser 默认偏好进入 Settings “对话”tab。
- Live Preview 不再由输入框承载；入口迁到 `SessionActionsMenu` / `DevServerLauncher`，并与当前 session、working directory 绑定。
- Browser / Computer 显式接入心智已经从 early concept 推进到 in-app managed browser 的本地受控生产化基线，详见 `2026-04-26-browser-use-production-roadmap.md`。

## 1. 结论

`Phase 1` 不改 swarm 引擎，只做三件事：

1. 把消息发送从“裸 content”扩成 `ConversationEnvelope`
2. 把 `workspace + routing` 收到输入框上方的 `InlineWorkbenchBar`
3. 把 `swarm:launch:requested` 拉回聊天流，先做内联启动确认卡片

这轮目标不是“做完整 workbench”，而是先把聊天主链路打通。

## 2. 成功标准

- 主聊天发送链能携带 `workingDirectory` 和 `routing` 上下文
- 用户消息能带上 `metadata.workbench`
- 输入框上方能显示并修改当前 `workspace` 与 `routing`
- `swarm:launch:requested` 在聊天区能看到内联卡片，并可直接批准/拒绝
- 现有 `TaskPanel`、旧 IPC payload、旧消息数据都保持可用

## 3. 非目标

这轮不做：

- skills / MCP / connectors 的完整 UI 入口
- turn 级 swarm/replay 全量时间线
- browser/computer-use 显式接入流程
- 持久化新的 launch trace 到历史消息
- 重写 `TaskPanel`、`SwarmMonitor` 或 swarm runtime

## 4. 核心决策

### 4.1 `ConversationEnvelope` 是消息级上下文，不是全局设置

`workingDirectory`、`routingMode`、`targetAgentIds` 这些都要跟着“这一次发送”走，而不是继续只放在全局 UI store 里。

### 4.2 `composerStore` 单独建，不继续塞进 `appStore`

`appStore` 里已经混了全局 UI、processing、planning、workspace。再往里塞“输入中临时选择态”，后面会越来越难拆。

### 4.3 Phase 1 的 launch card 先走“渲染层合流”，不碰 swarm 持久化

也就是：

- `swarmStore.launchRequests` 仍然是启动审批的真实来源
- 聊天区只是在当前 turn 内联投影这张卡
- `TaskPanel` 暂时保留为同一请求的并行入口

这能最快把体验拉回聊天主链路，同时不引入新的 trace 存储风险。

## 5. 数据模型

### 5.1 新增共享类型

新建文件：`src/shared/contract/conversationEnvelope.ts`

```ts
export type ConversationRoutingMode = 'auto' | 'direct' | 'parallel';

export interface ConversationRouting {
  mode: ConversationRoutingMode;
  targetAgentIds?: string[];
}

export interface ConversationEnvelopeContext {
  workingDirectory?: string | null;
  routing?: ConversationRouting;
  selectedSkillIds?: string[];
  selectedConnectorIds?: string[];
  selectedMcpServerIds?: string[];
}

export interface ConversationEnvelope {
  content: string;
  sessionId?: string;
  attachments?: import('./message').MessageAttachment[];
  options?: import('./appService').AppServiceRunOptions;
  context?: ConversationEnvelopeContext;
}

export interface WorkbenchMessageMetadata {
  workingDirectory?: string | null;
  routingMode?: ConversationRoutingMode;
  targetAgentIds?: string[];
  selectedSkillIds?: string[];
  selectedConnectorIds?: string[];
  selectedMcpServerIds?: string[];
}
```

设计约束：

- `ConversationEnvelopeContext` 用于发送
- `WorkbenchMessageMetadata` 用于消息快照
- 后者是前者的可持久化投影，不把运行时对象直接塞进消息

### 5.2 扩展消息契约

修改 [message.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/message.ts:1)：

```ts
export interface MessageMetadata {
  workbench?: WorkbenchMessageMetadata;
}

export interface Message {
  ...
  metadata?: MessageMetadata;
}
```

规则：

- 只给 `user` 消息写 `metadata.workbench`
- `assistant/tool/system` 先不写，避免 Phase 1 把解释层和执行层搅混

### 5.3 扩展 trace 契约

修改 [trace.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/trace.ts:1)：

```ts
export type TraceNodeType =
  | 'user'
  | 'assistant_text'
  | 'tool_call'
  | 'system'
  | 'swarm_launch_request';

export interface TraceNode {
  ...
  launchRequest?: import('./swarm').SwarmLaunchRequest;
  metadata?: import('./message').MessageMetadata;
}
```

这里故意不新建复杂 trace schema，先复用现有 `SwarmLaunchRequest`。

## 6. 文件级改动

### 6.1 Shared Contract

1. 新增 [conversationEnvelope.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/conversationEnvelope.ts)
   目标：定义 Phase 1 发送载荷和 workbench 元数据快照

2. 修改 [index.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/index.ts:1)
   目标：导出 `conversationEnvelope` 相关类型

3. 修改 [message.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/message.ts:1)
   目标：增加 `metadata.workbench`

4. 修改 [trace.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/trace.ts:1)
   目标：支持 `swarm_launch_request` 节点

### 6.2 Main Process / IPC

1. 修改 [appService.ts](/Users/linchen/Downloads/ai/code-agent/src/shared/contract/appService.ts:1)

把接口从参数散装改成 envelope：

```ts
sendMessage(envelope: ConversationEnvelope): Promise<void>;
interruptAndContinue(envelope: ConversationEnvelope): Promise<void>;
```

原因：

- `content + attachments + options + sessionId` 已经开始失控
- 再往后加 `context` 会让参数顺序越来越脆

2. 修改 [agent.ipc.ts](/Users/linchen/Downloads/ai/code-agent/src/main/ipc/agent.ipc.ts:1)

新增本地 helper：

```ts
function normalizeEnvelope(
  payload: string | SendMessagePayload | ConversationEnvelope
): ConversationEnvelope
```

兼容策略：

- legacy string payload 仍转成 `{ content: string }`
- 旧 object payload 仍映射到 `ConversationEnvelope`
- 新 payload 直接透传

`interrupt` 也走同样的 normalize 逻辑。

3. 修改 [agentAppService.ts](/Users/linchen/Downloads/ai/code-agent/src/main/app/agentAppService.ts:1)

职责：

- 解包 `ConversationEnvelope`
- 如有 `context.workingDirectory`，先调用 orchestrator `setWorkingDirectory(...)`
- 组装 `Message.metadata.workbench`
- 再调用 orchestrator `sendMessage(...) / interruptAndContinue(...)`

新增一个内部转换函数：

```ts
function toWorkbenchMetadata(
  context?: ConversationEnvelopeContext
): WorkbenchMessageMetadata | undefined
```

4. 修改 [agentOrchestrator.ts](/Users/linchen/Downloads/ai/code-agent/src/main/agent/agentOrchestrator.ts:132)

最小改动：

- `sendMessage` 增加可选参数 `messageMetadata?: MessageMetadata`
- `interruptAndContinue` 增加同样的可选参数
- 构造 `userMessage` 时带上 `metadata`

建议签名：

```ts
async sendMessage(
  content: string,
  attachments?: unknown[],
  options?: AgentRunOptions,
  messageMetadata?: MessageMetadata
): Promise<void>
```

```ts
async interruptAndContinue(
  newMessage: string,
  attachments?: unknown[],
  messageMetadata?: MessageMetadata
): Promise<void>
```

注意：

- `Auto / Parallel` 仍不直接重写 swarm runtime，主要表现为消息级意图 + 执行证据
- `Direct` 已不再只是 UI 回显；当前实现会通过 `swarm:send-user-message` 进入主进程 session 持久化链，再 fanout 给目标 agent
- 真正更丰富的多代理编排仍然不靠 `ConversationEnvelope.routing` 一步做完，而是继续交给 `CoworkContract` / launch builder / swarm runtime

5. 修改 [httpTransport.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/api/httpTransport.ts:146)

原因：

- web transport 现在对 `agent:send-message` 做了手工拆包
- 如果不补这里，Electron 版和 HTTP 版 payload 会分叉

最小要求：

- `POST /api/run` body 增加可选 `context`
- 若后端 API 暂不消费，也要做到无损透传

### 6.3 Renderer Store

1. 新增 [composerStore.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/stores/composerStore.ts)

建议状态：

```ts
interface ComposerState {
  workingDirectory: string | null;
  routingMode: ConversationRoutingMode;
  targetAgentIds: string[];
  selectedSkillIds: string[];
  selectedConnectorIds: string[];
  selectedMcpServerIds: string[];
  hydratedSessionId: string | null;

  hydrateFromSession(sessionId: string | null, workingDirectory: string | null): void;
  setWorkingDirectory(dir: string | null): void;
  setRoutingMode(mode: ConversationRoutingMode): void;
  setTargetAgentIds(ids: string[]): void;
  resetForSuccessfulSend(): void;
  buildContext(): ConversationEnvelopeContext | undefined;
}
```

约束：

- Phase 1 UI 只暴露 `workingDirectory` 和 `routing`
- 其他数组字段先在 store 层占位，给 Phase 2 继续接
- `resetForSuccessfulSend()` 不清空 `workingDirectory`
- `targetAgentIds` 在 `routingMode !== 'direct'` 时自动清空

2. 不修改 [appStore.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/stores/appStore.ts:27) 的职责边界

只保留：

- 当前全局 `workingDirectory`
- 侧边面板显隐

不把 composer 临时状态继续堆进去。

### 6.4 Renderer Send Chain

1. 修改 [useAgent.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/hooks/useAgent.ts:780)

把公开发送函数改成：

```ts
sendMessage(envelope: ConversationEnvelope): Promise<void>
```

改动点：

- optimistic user message 生成时写入 `metadata.workbench`
- `ipcService.invoke('agent:send-message', envelope)`
- interrupt 分支同样改用 envelope

前端 optimistic metadata 规则：

```ts
metadata: {
  workbench: toWorkbenchMetadata(envelope.context)
}
```

这一步很关键，因为聊天区需要在主进程回流前就能显示 workbench 上下文。

2. 修改 [ChatView.tsx](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/ChatView.tsx:305)

把：

```ts
handleSendMessage(content, attachments?)
```

改成：

```ts
handleSendMessage(envelope: ConversationEnvelope)
```

并保持 `requireAuthAsync` 包裹层不变。

### 6.5 Renderer UI

1. 新增 [InlineWorkbenchBar.tsx](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/features/chat/InlineWorkbenchBar.tsx)

Phase 1 只做 2 个区块：

- `WorkspaceChip`
- `RoutingChip`

展示规则：

- `WorkspaceChip`
  - 有目录时显示 basename
  - hover/title 显示完整路径
  - 点击后复用现有目录选择流程，不新造 picker
- `RoutingChip`
  - 三态：`Auto / Direct / Parallel`
  - `Direct` 时显示已选 agent 数
  - 第一版 agent 选择器可先复用 `useSwarmStore` 或现有 team agent 列表；如果没有已知 agent，先禁用 target 选择

2. 修改 [ChatInput/index.tsx](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/features/chat/ChatInput/index.tsx:1)

改动：

- `ChatInputProps.onSend` 改为 `(envelope: ConversationEnvelope) => void`
- 顶部插入 `InlineWorkbenchBar`
- `handleSubmit()` 构造 envelope：

```ts
const envelope: ConversationEnvelope = {
  content: trimmedValue,
  attachments: attachments.length > 0 ? attachments : undefined,
  context: buildContext(),
};
```

- `!command` 和 `iact:*` 这几条快捷发送路径也统一改走 envelope

注意：

- 本地 `value` 和 `attachments` 仍留在 `ChatInput` 内部
- 不把文本输入本身搬进 `composerStore`

3. 修改 [WorkingFolder.tsx](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/TaskPanel/WorkingFolder.tsx:1)

不重写，只做一件事：

- 如果 `composerStore.workingDirectory` 与 `appStore.workingDirectory` 不同，明确显示“下一条消息将使用”的路径

这一步不是必须首批上线，但建议一并做，避免用户在主链路改了目录，侧栏还显示旧值。

### 6.6 Trace / Inline Launch Card

1. 修改 [useTurnProjection.ts](/Users/linchen/Downloads/ai/code-agent/src/renderer/hooks/useTurnProjection.ts:1)

签名扩成：

```ts
useTurnProjection(
  messages: Message[],
  sessionId: string | null,
  isProcessing: boolean,
  launchRequests: SwarmLaunchRequest[]
): TraceProjection
```

投影规则：

- 先按现有逻辑投影消息
- 如果存在 `status === 'pending'` 的 launch request，则把最新一个 pending request 作为一个 `swarm_launch_request` 节点，挂到最后一个 turn
- 如果当前没有 turn，则新建一个只含 launch card 的 turn

Phase 1 限制：

- 只投影最近一个 pending request
- 不投影已 resolved 的历史 request
- 不做 session 级追溯

2. 修改 [TraceNodeRenderer.tsx](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/features/chat/TraceNodeRenderer.tsx:1)

新增 `case 'swarm_launch_request'`

实现方式：

- 把 [Orchestration.tsx](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/TaskPanel/Orchestration.tsx:516) 里的 `LaunchRequestCard` 提取到新组件
- 新文件建议：
  - `src/renderer/components/features/swarm/LaunchRequestCard.tsx`

然后两边共用：

- `TaskPanel/Orchestration.tsx`
- `TraceNodeRenderer.tsx`

这样能保证审批按钮、反馈框、状态 badge 全部共用，不做两份逻辑。

3. 修改 [TaskPanel/Orchestration.tsx](/Users/linchen/Downloads/ai/code-agent/src/renderer/components/TaskPanel/Orchestration.tsx:516)

只做组件抽取，不改审批逻辑。

## 7. 发送链路

### 7.1 当前真实发送链

#### 普通 `Auto / Parallel`

1. 用户在 `ChatInput` 里输入内容
2. 用户在 `InlineWorkbenchBar` 选择 `workspace/routing`
3. `ChatInput.handleSubmit()` 组装 `ConversationEnvelope`
4. `ChatView.handleSendMessage()` 透传 envelope 给 `useAgent.sendMessage`
5. `useAgent` 先 optimistic add 一条带 `metadata.workbench` 的 user message
6. `ipcService.invoke('agent:send-message', envelope)`
7. `agent.ipc.ts` normalize payload
8. `agentAppService.ts` 根据 `context` 设置 working directory，并把 context 转成 metadata
9. `agentOrchestrator.sendMessage(...)` 持久化 user message

#### `Direct`

1. `useAgent.resolveDirectRouting(...)` 在 renderer 先解析目标 agent，并给 optimistic user message 写入 `metadata.workbench` 与 `directRoutingDelivery`
2. renderer 调 `swarm:send-user-message`，把 `sessionId + messageId + timestamp + metadata` 一起带到主进程
3. `swarm.ipc.ts` 先 `buildPersistedUserMessage(...)`，再调用 `getSessionManager().addMessageToSession(...)`
4. 只有持久化成功（或命中重复写入的幂等分支）后，才调用 `teammateService.onUserMessage(...)` 与 `swarmEventEmitter.userMessage(...)`
5. 如果是非重复写入失败，主进程返回 `delivered: false / persisted: false`，renderer 回滚 optimistic user message，并明确提示“当前消息没有写入会话”
6. 历史切会话 / reload / Replay 时，`SessionRepository` 会把 `metadata.workbench` 再 hydrate 回来；如果 live routing event 已消失，`turnTimelineProjection` 仍可从持久化 metadata 重建 Direct routing evidence，`telemetryQueryService` 在 telemetry 缺席时也会退回 session transcript replay

### 7.2 中断继续

同一条链路，只是 IPC action 变成 `interrupt`。

注意：

- Phase 1 的 interrupt 只要求带上新消息的 workbench metadata
- 不要求把历史 routing intent 合并回 runtime

## 8. 兼容策略

1. 旧 `agent:send-message` string payload 继续支持
2. 旧 `{ content, attachments, sessionId }` object payload 继续支持
3. 没有 `metadata.workbench` 的旧消息照常渲染
4. 没有 `launchRequests` 的会话，trace 完全不变
5. `TaskPanel` 继续保留 launch approval 入口，直到聊天内联卡片稳定

## 9. 实施顺序

### Slice 1：类型和 IPC 打底

涉及文件：

- `src/shared/contract/conversationEnvelope.ts`
- `src/shared/contract/index.ts`
- `src/shared/contract/message.ts`
- `src/shared/contract/trace.ts`
- `src/shared/contract/appService.ts`
- `src/main/ipc/agent.ipc.ts`
- `src/main/app/agentAppService.ts`
- `src/main/agent/agentOrchestrator.ts`
- `src/renderer/api/httpTransport.ts`

验证：

- `ipc-handlers` 单测通过
- 旧 payload 和新 payload 都能走通

### Slice 2：composer store 和 ChatInput

涉及文件：

- `src/renderer/stores/composerStore.ts`
- `src/renderer/components/features/chat/InlineWorkbenchBar.tsx`
- `src/renderer/components/features/chat/ChatInput/index.tsx`
- `src/renderer/components/ChatView.tsx`
- `src/renderer/hooks/useAgent.ts`

验证：

- 发送消息时 metadata.workbench 能出现在前端消息对象里
- 切换 workspace / routing 后，下一条发送 payload 正确变化

### Slice 3：inline launch card

涉及文件：

- `src/renderer/components/features/swarm/LaunchRequestCard.tsx`
- `src/renderer/components/TaskPanel/Orchestration.tsx`
- `src/renderer/hooks/useTurnProjection.ts`
- `src/renderer/components/features/chat/TraceNodeRenderer.tsx`
- `src/renderer/components/ChatView.tsx`

验证：

- `swarm:launch:requested` 出现时，聊天区能看到内联卡片
- 在聊天区点批准/拒绝，`TaskPanel` 状态同步变化

## 10. 测试计划

### 10.1 单元测试

1. 修改 [ipc-handlers.test.ts](/Users/linchen/Downloads/ai/code-agent/tests/unit/ipc/ipc-handlers.test.ts:1)

新增断言：

- `send` action 能接受 `ConversationEnvelope`
- legacy payload 仍能被 normalize

2. 新增 `tests/renderer/stores/composerStore.test.ts`

覆盖：

- `hydrateFromSession`
- `setRoutingMode`
- `targetAgentIds` 在非 `direct` 模式下被清空
- `buildContext()` 的空值折叠

3. 新增 `tests/renderer/hooks/useTurnProjection.test.ts`

覆盖：

- pending launch request 被投影成 `swarm_launch_request`
- 无消息时也能生成最小 turn

### 10.2 组件测试或轻 UI 测试

如果当前仓库已有 renderer test harness，建议补：

- `InlineWorkbenchBar` workspace/routing 展示
- `LaunchRequestCard` approve/reject 分支

如果没有现成 harness，则先落在 Playwright smoke。

### 10.3 E2E / Smoke

优先补这两条：

1. 修改 [tests/ui.spec.ts](/Users/linchen/Downloads/ai/code-agent/tests/ui.spec.ts:1)
   目标：空会话能看到 `InlineWorkbenchBar`

2. 视情况扩展 [tests/e2e/swarm-chain.spec.ts](/Users/linchen/Downloads/ai/code-agent/tests/e2e/swarm-chain.spec.ts:1)
   目标：触发 launch request 后，聊天区出现内联启动确认卡片

## 11. 风险

### 11.1 optimistic message 与持久化消息不一致

风险来源：

- 前端先加 user message，主进程再持久化一遍

应对：

- 前后都使用同一份 `workbench metadata` 结构
- `Direct` 已通过主进程持久化先于 fanout 的链路，把这类不一致风险压成“失败就回滚，不假装成功”
- `SessionRepository` 已把 `messages.metadata` 写入 / 读回；Replay 也已补 transcript fallback 与 metadata replay

### 11.2 launch card 只投影 pending request，历史不完整

这是 Phase 1 的有意取舍，不认它是 bug。

真正的历史 replay 归 `Phase 3 Turn Workbench Trace`。

### 11.3 `routing` 的当前真实边界

这块现在要分开说，不能再用一句“只是 UI 意图”概括。

- `Direct`：已经是真发送链，会进入主进程 session 持久化，再 fanout 给目标 agent
- `Auto / Parallel`：仍主要是消息级意图 + 执行证据，不等于一次性重做 swarm runtime

所以当前边界是：

`把用户意图写进消息链路，并且让 Direct 至少先成为可信、可重放、可回看的真实链路`

而不是：

`一步做完完整的多代理编排重构`

## 12. 验收口径

我认的验收只有这 5 条：

1. 用户能在聊天输入框上方明确看到当前 `workspace`
2. 用户能在发送前明确切换 `routing`
3. 发送后的 user message 自带 workbench context 快照
4. swarm launch approval 不必切去右侧面板也能操作
5. 旧发送链和旧消息都没被打坏

做到这 5 条，`Phase 1` 就算真正把聊天主链路收回来了一步。

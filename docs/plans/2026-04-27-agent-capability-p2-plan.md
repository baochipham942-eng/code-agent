# Agent 能力 P2 优化计划

日期：2026-04-27

范围：P0/P1 之后，处理当前 `code-agent` 真实产品运行链路里不阻断主功能、但会造成误导、恢复不完整、解释能力不足的 P2 缺口。

## 结论

P2 的重点是“别让产品表面承诺大于运行时事实”。这些问题通常不会直接让 agent 跑不起来，但会在重启、断流、工具搜索、replay、eval 时暴露为不可信。

建议顺序：

1. streaming tool call snapshot。
2. LoopDecision 语义降级或接实。
3. ToolSearch 不可调用项显式标记。
4. compact / persistent context 恢复面。
5. replay/eval completeness gate。

## Closing 状态

状态日期：2026-04-27

P2 代码与定向测试已完成最小闭环。1-8 没有继续作为 P2 blocker 的 active path 缺口；剩余项转为真实运行验证或后续 recovery smoke，不混进 P2 closing。

| 项 | 状态 | 当前闭环口径 | 延后风险 |
|---|---|---|---|
| 1. streaming tool call snapshot | closed | `inference` 接入 stream snapshot；半截 tool arguments 断流会标记 incomplete，并拒绝进入执行阶段；load session 能带回匹配 snapshot。 | 真实 app reload 后 UI 展示仍可补 smoke。 |
| 2. LoopDecision compact/fallback/terminate | closed | 已选择 advisory 降级路线；只有 `continuation` 是 runtime-executable，compact/fallback/terminate 不再暗示已接执行策略。 | 若未来要接真实 compact/fallback，需要按新产品合同重开。 |
| 3. ToolSearch 不可调用项标记 | closed | search-only metadata 返回 `loadable:false` 和 `notCallableReason`，不会进入 loaded deferred tools。 | 可补真实模型下一轮 tools list smoke，但不是 P2 blocker。 |
| 4. lazy stdio MCP discovery | closed | ToolSearch 前会按 query 触发 lazy stdio discover，并返回 server-level discovery 结果或失败元数据。 | 真实 stdio server spawn smoke 延后。 |
| 5. manual compact / persistent context 恢复 | closed at unit level | manual compact 的 compacted messages、serialized compression state、context event ledger 能在 reload 后重建 context view/provenance；persistent system context 和 compression state 已有 session runtime state 恢复链。 | 真实 app restart smoke 延后，不在 P2 里继续扩大。 |
| 6. cancel partial assistant 策略 | closed | cancel 有 `agent_cancelled` 终态、run-level abort、partial assistant cancelled marker，late tool result 会被抑制。 | 真实 UI/API cancelled terminal smoke 延后，避免踩 run lifecycle 重构。 |
| 7. interrupt/steer user message id | closed | renderer optimistic `clientMessageId` 会传到 backend steer，并用于同一 session 持久化。 | stream 中 interrupt 后真实 reload 去重/order smoke 延后。 |
| 8. eval telemetry/replay completeness | closed | `real-agent-run` gate 输出并校验 `sessionId + replayKey + telemetryCompleteness`，缺 model/tool/replay explanation 会 fail/degraded。 | 真实 AgentLoop + tool + telemetry + structured replay 的完整 eval smoke 延后。 |

本轮新增的 P2-5 关账测试：

- `tests/unit/ipc/context.ipc.test.ts`：`rebuilds manual compact provenance from persisted session state after reload`

本轮收口验证：

- `npx vitest run tests/unit/session/streamSnapshot.test.ts tests/unit/agent/loopDecision.test.ts tests/unit/services/toolSearchService.test.ts tests/unit/mcp/mcpToolRegistry.test.ts tests/unit/protocol/toolResolver.mcpDirect.test.ts tests/unit/tools/toolExecutor.mcpDirect.test.ts tests/unit/context/contextInterventionState.persistence.test.ts tests/unit/agent/systemContextStack.persistence.test.ts tests/unit/agent/cancelCorrectness.test.ts tests/renderer/components/swarmInlineMonitor.cancel.test.ts tests/unit/ipc/evaluation.ipc.test.ts tests/unit/evaluation/experimentAdapter.test.ts tests/unit/ipc/context.ipc.test.ts`
- `npm run typecheck`
- `git diff --check`

## P2 Findings

### 1. streaming tool call 半截状态不持久

分类：完整 tool call/result 已落库，流式中间态缺 checkpoint。

关键路径：
- `src/main/agent/runtime/contextAssembly/inference.ts`
- `src/main/model/providers/sseStream.ts`
- `src/main/agent/runtime/messageProcessor.ts`
- `src/main/services/core/repositories/SessionRepository.ts`

问题：
- SSE parser 有 snapshot 设计，但 inference 主链没有把 snapshot 接到 runtime/session draft。
- renderer 会收到 volatile stream event，进程断掉后半截 tool args 不能恢复。
- 无 `[DONE]` 的 fallback 可能 resolve 累积 toolCalls，但没有完整 incomplete/truncated 语义。

最小修复：
- 接上 `onSnapshot` 到 session draft 或 turn snapshot。
- 无 `[DONE]` 断流时标记 incomplete/truncated。
- incomplete tool call 不允许进入执行阶段。

验证：
- fake SSE 在 tool_call arguments 输出一半时断流。
- reload 后能看到未完成 tool call 状态。
- 半截 arguments 不会被执行。

### 2. LoopDecision 的 compact/fallback/terminate 只记录日志

分类：文档承诺但未实现为执行策略。

关键路径：
- `src/main/agent/runtime/conversationRuntime.ts`
- `src/main/agent/loopDecision.ts`
- `src/main/agent/runtime/contextAssembly/inference.ts`
- `src/main/model/modelRouter.ts`

问题：
- `continuation` 会注入 prompt。
- `compact`、`fallback`、`terminate` 目前主要是 logger。
- 真正 context overflow compact 和 provider fallback 在其他路径单独处理。

最小修复：
- 二选一：
  - 把 `compact/fallback/terminate` 接到真实行为。
  - 或把 LoopDecision 明确降级成 advisory，改名或删掉会误导维护者的承诺。

验证：
- 构造 context pressure case，确认 decision compact 真触发 compression。
- 构造 provider fallback case，确认 decision fallback 真触发 model fallback。
- 如果选择 advisory，测试明确不依赖这些 action 执行。

### 3. ToolSearch 搜得到但下一轮不可调用

分类：UI/LLM 可见，runtime 不完整。

关键路径：
- `src/main/services/toolSearch/deferredTools.ts`
- `src/main/services/toolSearch/toolSearchService.ts`
- `src/main/protocol/dispatch/toolDefinitions.ts`
- `src/main/tools/modules/index.ts`

问题：
- 一些 `desktop_activity_*` / `workspace_activity_search` 只在 deferred meta 里。
- 没有对应 protocol tool registration。
- ToolSearch 命中后，模型可能以为可以 select 后调用。

最小修复：
- 补真实 protocol module。
- 或从 deferred meta 移除未注册项。
- 或 ToolSearch 返回 `loadable:false/reason`，明确这是概念命中，不可直接调用。

验证：
- `ToolSearch("desktop activity")` 命中不可调用项时，结果包含 not-callable reason。
- 下一轮 tools list 不会暗示这些工具可调用。

### 4. lazy stdio MCP 服务器搜索前不可发现

分类：MCP lifecycle 已接入，discovery 与 search 没接顺。

关键路径：
- `src/main/mcp/mcpClient.ts`
- `src/main/mcp/mcpToolRegistry.ts`
- `src/main/services/toolSearch/toolSearchService.ts`

问题：
- `connectAll()` 默认跳过 lazy stdio server。
- MCP tools 只有 connect/discover 后才注册到 ToolSearch。
- 用户搜索相关 tool 时，已启用 lazy server 可能完全不可见。

最小修复：
- ToolSearch 遇到 lazy MCP server 候选时触发轻量 discover。
- 或返回 server-level discover/load result。

验证：
- 保持 sequential-thinking lazy/disconnected，搜索 sequential 能触发 discover 或返回可加载 server 项。

### 5. manual compact / persistent context 恢复面不完整

分类：active runtime path，但持久恢复不完整。

关键路径：
- `src/main/ipc/contextHealth.ipc.ts`
- `src/main/agent/runtime/contextAssembly/systemContextStack.ts`
- `src/main/agent/runtime/contextAssembly/compression.ts`
- `src/main/app/restoreSession.ts`

问题：
- manual compact 只改 live orchestrator messages，没有完整写回 session。
- persistent system context 只在 runtime memory array。
- auto compaction 的 compression state 没有稳定 restore path。

最小修复：
- compact summary 和被压缩消息状态写入 session storage。
- persistent system context 和 compression snapshot 存 session metadata 或独立表。
- restore session 时恢复 compression state。

验证：
- compact 后 reload session，仍是 compact 后上下文。
- 强制低阈值 compaction 后重启，context view 仍有 compression commit/provenance。

### 6. cancel 被当成 complete，partial assistant 策略不清

分类：已接入生产主链，但事件语义不清。

关键路径：
- `src/main/agent/agentOrchestrator.ts`
- `src/main/agent/runtime/conversationRuntime.ts`
- `src/main/agent/runtime/contextAssembly/systemContextStack.ts`

问题：
- orchestrator cancel 直接 emit `agent_complete`。
- runtime cancel 尝试保存 partial，但生产构造 AgentLoop 时没有传 `persistMessage`。
- 取消后的 partial assistant 到底存不存，没有明确产品合同。

最小修复：
- 增加明确 `agent_cancelled` 或 terminal status。
- partial 内容策略二选一：
  - 不存 partial，但写 cancelled marker。
  - 存 partial，通过 ContextAssembly 持久化，并标记 partial/cancelled。

验证：
- 中途 cancel 后 reload，能看到明确 cancelled marker。
- partial 内容策略稳定且有测试覆盖。

### 7. interrupt/steer 的用户消息 id 可能不一致

分类：已接入生产主链，UI/DB 一致性风险。

关键路径：
- `src/renderer/hooks/agent/useAgentIPC.ts`
- `src/main/agent/agentOrchestrator.ts`
- `src/main/agent/runtime/messageProcessor.ts`

问题：
- UI interrupt 前乐观插入 user message。
- backend steer 持久化时重新生成 id。
- reload 后 UI 当时看到的 id/order 可能和 DB 不一致。

最小修复：
- interrupt envelope 带 clientMessageId，backend 使用同一 id。
- 或取消乐观插入，等 backend echo。

验证：
- stream 中 interrupt 后 reload session。
- 只有一条 steer user message，id/content/order 一致。

### 8. eval 没绑定真实 telemetry/replay 完整性

分类：有真实 AgentLoop adapter，但 coverage gate 偏弱。

关键路径：
- `src/main/testing/agentAdapter.ts`
- `src/main/testing/testRunner.ts`
- `packages/eval-harness/src/runner/ExperimentRunner.ts`
- `src/main/evaluation/snapshotBuilder.ts`

问题：
- StandaloneAgentAdapter 能跑真实 AgentLoop，但没有复用 production telemetry adapter。
- eval-harness 主要按 final response 评分。
- snapshot 只拿 summary tool calls，不校验 replay artifact。

最小修复：
- 增加 `real-agent-run` eval gate。
- runner 输出 `sessionId + replayKey + telemetryCompleteness`。
- 缺 model_calls/tool_calls/replay explanation 时标 degraded 或 fail。

验证：
- 一个需要真实工具、上下文、验证命令的 eval case。
- result 能通过 `getStructuredReplay(sessionId)` 追到 model input、tool args/result、decision event。

## 新会话提示词

```text
你在 /Users/linchen/Downloads/ai/code-agent 继续。
先按 AGENTS.md 做 memory bootstrap。
然后读 docs/plans/2026-04-27-agent-capability-p2-plan.md。

本轮只做 P2 的第 <N> 项：<finding 名称>。
先读 active path，再判断是补 runtime、降级文案，还是补测试。
只做最小闭环，不扩大到 P1 或架构债。
改完跑定向测试；没有现成测试就补最小 unit test。
输出按：改了什么、验证命令与结果、剩余风险、下一项是否可开始。

过程中可以开 Agent Team：
- 一个 agent 查 active path 和现有测试；
- 一个 agent 做最小 patch；
- 一个 agent 做回归验证或测试补齐。
主 agent 最后整合并复核。
```

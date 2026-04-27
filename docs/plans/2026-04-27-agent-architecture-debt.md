# Agent 多代架构叠加工程债

日期：2026-04-27

范围：当前 `code-agent` 的 agent runtime、tools、MCP/Skill、swarm、persistence、telemetry/replay。这里只记录结构性工程债，不替代 P0/P1/P2 修复计划。

## 结论

仍然存在明显的多代 agent 架构叠加债。

它不是“代码风格不统一”这种低优先级问题，而是已经影响到：

- 权限是否真的生效。
- 工具是否可见即可执行。
- run 是否有唯一 owner 和唯一终态。
- multiagent 的消息、取消、依赖、归并是否可信。
- replay 是否能解释一次真实 agent run。

## 债务 1：tool execution 三代并存

涉及层：
- legacy Tool / legacy ToolContext
- protocol ToolModule / ProtocolToolContext
- ToolExecutor / ToolResolver / wrapper adapter

关键文件：
- `src/main/tools/modules/_helpers/legacyAdapter.ts`
- `src/main/tools/toolExecutor.ts`
- `src/main/protocol/dispatch/toolResolver.ts`
- `src/main/protocol/dispatch/shadowAdapter.ts`
- `src/main/tools/modules/index.ts`

症状：
- legacy wrapper 外层跑一次 `canUseTool`，内层 `requestPermission` 又是另一套语义。
- native protocol handler 可能二次审批。
- tool name 大小写、permission level、approval trace、audit log 不完全共用。
- wrapper 迁移期注释还在，说明这不是稳定终态。

已经造成的问题：
- Browser/Computer 内层审批被放行。
- Bash 安全策略受大小写影响。
- native tool 审批可能重复或不一致。

收敛方向：
- ToolExecutor 是唯一权限入口。
- ToolResolver 只负责 dispatch，不重新发明审批。
- legacy wrapper 的 `requestPermission` 必须转发到统一 permission contract。
- wrapper 工具逐步改成 native protocol module，减少 opaque legacy context。

## 债务 2：tool discoverability 与 executability 分裂

涉及层：
- `ToolSearchService`
- `toolDefinitions`
- protocol registry
- MCP registry
- Skill virtual entries

关键文件：
- `src/main/services/toolSearch/toolSearchService.ts`
- `src/main/services/toolSearch/deferredTools.ts`
- `src/main/protocol/dispatch/toolDefinitions.ts`
- `src/main/mcp/mcpToolRegistry.ts`
- `src/main/services/skills/skillDiscoveryService.ts`

症状：
- 有些工具搜索得到，但下一轮不一定进 tool definitions。
- MCP dynamic definitions 能暴露，但 ToolResolver 不能 direct execute。
- Skill 搜索项像 tool，但真实调用方式仍是 `Skill(command)`。
- lazy MCP server 未 discover 前，ToolSearch 不一定知道它的 tools。

已经造成的问题：
- MCP dynamic direct execute 断链。
- ToolSearch 命中不可调用项。
- Skill search/selection 容易误导 planning。

收敛方向：
- 每个 search result 明确 `loadable/callable/reason/canonicalInvocation`。
- model-visible tool definition 必须能被 ToolExecutor 执行。
- MCP dynamic tool 进入统一 resolver。
- Skill 结果明确返回 `Skill(command=...)`，不要伪装成独立 tool。

## 债务 3：run lifecycle 多 owner

涉及层：
- AgentAppService
- AgentOrchestrator
- ConversationRuntime / AgentLoop
- TaskManager
- SessionStateManager
- renderer processing state

关键文件：
- `src/main/app/agentAppService.ts`
- `src/main/agent/agentOrchestrator.ts`
- `src/main/agent/runtime/conversationRuntime.ts`
- `src/main/task/TaskManager.ts`
- `src/main/ipc/agent.ipc.ts`
- `src/main/ipc/task.ipc.ts`

症状：
- desktop chat 直接进 orchestrator。
- TaskManager 也有 queue/semaphore/status，但不是 chat 主 owner。
- renderer 可能同时读取 session state 和 task state。
- pause/cancel/error 的 terminal event 不统一。

已经造成的问题：
- 同一 session 状态可能漂移。
- cancel 只取消 inference，不取消工具。
- pause/resume UI 存在，但 runtime 不能恢复同一个 run。
- 异常可能绕过 finalizer。

收敛方向：
- 定义唯一 run owner。
- run terminal state 统一为 `completed | failed | cancelled | paused/interrupted`。
- send/cancel/interrupt/pause/resume 都走同一个 owner。
- renderer 只消费单一状态源。

## 债务 4：multiagent / swarm 多实现并存

涉及层：
- hybrid AgentSwarm
- ParallelAgentCoordinator
- AutoAgentCoordinator
- SpawnGuard / spawnAgent tools
- TeammateService mailbox
- SwarmEventEmitter / SwarmTraceWriter

关键文件：
- `src/main/agent/hybrid/agentSwarm.ts`
- `src/main/agent/parallelAgentCoordinator.ts`
- `src/main/agent/autoAgentCoordinator.ts`
- `src/main/agent/multiagentTools/spawnAgent.ts`
- `src/main/agent/teammate/teammateService.ts`
- `src/main/ipc/swarm.ipc.ts`
- `src/main/agent/swarmTraceWriter.ts`

症状：
- UI 看起来是一个 Agent Team，但消息路由不一定到真实 executor。
- dependsOn 和 DAG 语义像 best-effort fanout。
- cancel 有逐 agent cancel、spawn guard cancel、hybrid cancel，但缺统一 run-level cancel。
- trace writer 假设同一时刻一个 active run。

已经造成的问题：
- `swarm:send-user-message` 可能假 delivered。
- 上游失败下游仍执行。
- aggregation 可能把部分失败洗成高成功率。
- launch approval 生命周期可能不落 trace。

收敛方向：
- 选定生产 swarm runtime。
- 定义 agent inbox、dependency gate、result shape、run cancel 的统一 contract。
- 其他 legacy/hybrid 路径降级为 adapter 或标 unsupported。
- trace/runId 从 launch request 开始就稳定存在。

## 债务 5：persistence 层粒度不一致

涉及层：
- sessions/messages/todos SQLite
- pending approvals
- taskStore in-memory
- context intervention in-memory
- compression state in-memory
- light memory json file
- telemetry/swarm trace tables

关键文件：
- `src/main/services/core/repositories/SessionRepository.ts`
- `src/main/services/core/repositories/PendingApprovalRepository.ts`
- `src/main/services/planning/taskStore.ts`
- `src/main/context/contextInterventionState.ts`
- `src/main/agent/runtime/contextAssembly/systemContextStack.ts`
- `src/main/agent/runtime/contextAssembly/compression.ts`
- `src/main/lightMemory/sessionMetadata.ts`

症状：
- messages 和 metadata 落库较完整。
- task、todo、context intervention、compression state、persistent system context 粒度不一致。
- 有些状态可以重启恢复，有些只能靠 live singleton。

已经造成的问题：
- task/todo 重启丢。
- pin/exclude 重启丢。
- compact 后 reload 可能回到未 compact 历史。
- running/queued crash 后可能静默 idle。

收敛方向：
- 明确哪些状态必须 durable，哪些是 ephemeral。
- durable 状态统一 session-scoped SQLite。
- ephemeral 状态 crash 后必须有 orphan/interrupted marker。
- context view 与 model context 使用同一套恢复后的状态。

## 债务 6：observability / replay 与真实 runtime 未完全同构

涉及层：
- telemetry collector/storage
- standard AgentLoop telemetry adapter
- auto-agent/subagent executor
- replayService / telemetryQueryService
- eval harness / TestRunner

关键文件：
- `src/main/telemetry/telemetryCollector.ts`
- `src/main/telemetry/telemetryStorage.ts`
- `src/main/agent/subagentExecutor.ts`
- `src/main/evaluation/replayService.ts`
- `src/main/evaluation/telemetryQueryService.ts`
- `src/main/testing/agentAdapter.ts`
- `packages/eval-harness/src/runner/ExperimentRunner.ts`

症状：
- standard loop 有 telemetry。
- auto-agent/subagent 直接调用 model/tool，telemetry 不完整。
- replay 更像 transcript reconstruction，不是 decision replay。
- eval 可跑真实 AgentLoop，但不强制 telemetry/replay completeness。

已经造成的问题：
- 复杂 auto-agent run 难以复现。
- replay 解释不了“为什么调用这个工具”。
- eval 可能只测到 final string 或孤立函数。

收敛方向：
- 每个 runtime path 都写同一种 run artifact。
- replay 必须能关联 model input、model output/tool_call、tool schema、permission decision、tool result。
- eval gate 绑定 replay completeness，不只看 final answer。

## 收敛路线

建议按这个顺序还债：

1. 先修 P0，避免安全和 direct execute 硬断点继续污染后续判断。
2. 收 ToolExecutor/ToolResolver/legacy wrapper 的权限合同。
3. 定义唯一 run owner 和 terminal state。
4. 选定生产 swarm runtime，把其他实现降级为 adapter 或 legacy。
5. 统一 durable state 边界，补恢复面。
6. 把 telemetry/replay/eval 做成同构验证链。

## 新会话提示词

```text
你在 /Users/linchen/Downloads/ai/code-agent 继续。
先按 AGENTS.md 做 memory bootstrap。
然后读 docs/plans/2026-04-27-agent-architecture-debt.md。

本轮只处理工程债第 <N> 项：<债务名称>。
先确认 active production path 和 legacy path 边界。
给一个最小收敛切片，不做全仓重构。
改完跑定向测试或 smoke。
输出按：收敛了哪条 contract、哪些 legacy 路径还保留、验证命令与结果、剩余风险。

过程中可以开 Agent Team：
- 一个 agent 负责 active path tracing；
- 一个 agent 负责 legacy/test-only 边界确认；
- 一个 agent 负责测试或 smoke 验证。
主 agent 最后整合并复核。
```

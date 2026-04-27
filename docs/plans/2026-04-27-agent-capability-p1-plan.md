# Agent 能力 P1 优化计划

日期：2026-04-27

范围：P0 修完之后，继续收敛当前 `code-agent` 真实产品运行链路里的 P1 缺口。只覆盖 active production path，不把 legacy-only、test-only、harness-only 代码当主证据。

## 结论

P1 的核心不是“能力没做”，而是能力已经进了产品链路，但状态机、权限语义、multiagent 协作和跨重启恢复还没有收成稳定合同。

优先顺序建议：

1. tool 权限模型收口。
2. run lifecycle 单一状态机。
3. swarm / multiagent 产品化补洞。
4. persistence 恢复面补齐。
5. replay/telemetry 解释能力增强。

## Closing 状态

状态日期：2026-04-27

P1 代码与定向测试已完成最小闭环。1-8 的 active path 缺口不再继续作为 P1 blocker；剩余风险转入真实运行 smoke 和后续工程债收敛，不继续混在 P1 里扩大范围。

| 项 | 状态 | 当前闭环口径 | 延后风险 |
|---|---|---|---|
| 1. run lifecycle 终态不统一 | closed at unit level | `ConversationRuntime.run` 统一 terminal path；failure/cancel/interrupted 进入 finalizer；pause/resume 保留同一个 live loop。 | 还需要真实 app 长 run pause/resume smoke。 |
| 2. cancel 不能真正中断正在执行的工具 | closed | run-level abort signal 贯穿 `ToolExecutionEngine -> ToolExecutor -> ToolResolver -> ProtocolToolContext`，Bash/http 等长工具能响应 cancel。 | 真实 UI cancel 长命令 smoke 可继续补。 |
| 3. desktop chat 与 TaskManager 是两套运行状态 | closed | `AgentAppService.sendMessage` 改走 TaskManager-owned send；interrupt 也经 TaskManager 路由；TaskStore/ChatView 不再和 direct orchestrator send 分裂。 | 唯一 run owner 的更彻底收敛应放进工程债第 3 项。 |
| 4. Bash 和 native protocol 权限语义不一致 | closed | `Bash/bash` 归一；顶层审批结果通过 `approvedToolCall` 传给 resolver；native handler 不再重复审批同一 tool+args。 | ToolExecutor/ToolResolver 的长期单一权限合同仍属工程债第 1 项。 |
| 5. Skill allowed-tools 会自动扩权 | closed | 只有 builtin/plugin skill 可自动进入 preapproval；project/user skill 的 `allowed-tools` 不再直接扩权；pattern grammar 已校验。 | project skill 显式授权 UI 可作为后续产品增强。 |
| 6. swarm 运行可靠性不足 | closed at unit level | parallel inbox、dependency gate、failed/blocked/cancelled aggregation、run-level cancel 都有定向覆盖。 | 真实 Agent Team 多 agent smoke 仍可补。 |
| 7. approval / task / context intervention 跨重启恢复不完整 | closed at unit level | approval 按 kind hydrate/orphan；task/todo/context intervention/runtime state 按 session 持久化。 | 真 app restart/reload recovery smoke 延后。 |
| 8. auto-agent / replay observability 不足 | closed at unit level | auto-agent telemetry 接入，replay query 关联 model/tool/event 完整性，eval gate 能 fail/degraded。 | 真实 AgentLoop + auto-agent + replay 端到端 smoke 延后。 |

本轮收口验证：

- `npx vitest run tests/unit/app/agentAppService.lifecycle.test.ts tests/unit/task/TaskManager.persistence.test.ts`
- `npx vitest run tests/unit/ipc/ipc-handlers.test.ts tests/unit/app/agentAppService.lifecycle.test.ts tests/unit/task/TaskManager.persistence.test.ts tests/renderer/components/chatView.sessionWorkspace.actions.test.ts tests/renderer/components/chatView.sessionWorkspace.test.ts`
- `npx vitest run tests/unit/agent/conversationRuntime.test.ts tests/unit/app/agentAppService.lifecycle.test.ts tests/unit/tools/toolExecutor.protocolApproval.test.ts tests/unit/tools/legacyAdapter.permission.test.ts tests/unit/tools/skillMetaTool.security.test.ts tests/unit/agent/parallelAgentCoordinator.test.ts tests/unit/agent/sendInput.test.ts tests/unit/agent/resultAggregator.test.ts tests/unit/agent/approvalPersistence.test.ts tests/unit/services/PendingApprovalRepository.test.ts tests/unit/task/TaskManager.persistence.test.ts tests/unit/agent/todoParser.persistence.test.ts tests/unit/services/planningTaskStore.persistence.test.ts tests/unit/services/SessionRepository.runtimeState.test.ts tests/unit/agent/messageProcessor.persistence.test.ts tests/unit/agent/autoAgentRunner.telemetry.test.ts tests/renderer/stores/swarmStore.test.ts tests/renderer/components/chatView.sessionWorkspace.actions.test.ts tests/renderer/components/chatView.sessionWorkspace.test.ts tests/unit/ipc/ipc-handlers.test.ts`
- `npx vitest run tests/unit/tools/modules/shell/bash.test.ts tests/unit/tools/modules/network/httpRequest.test.ts tests/security/toolExecutor-safety.test.ts`
- `npm run typecheck`
- `git diff --check`

## P1 Findings

### 1. run lifecycle 终态不统一

分类：已接入生产主链，但状态机不完整。

关键路径：
- `src/main/agent/runtime/conversationRuntime.ts`
- `src/main/agent/agentOrchestrator.ts`
- `src/main/app/agentAppService.ts`

问题：
- pause 只置位，主循环退出后仍可能走 finalizer。
- orchestrator finally 会清空 `agentLoop`，resume 可能只改状态，没有同一个 loop 可恢复。
- 非预期异常会绕过 `RunFinalizer`，导致 trace、hook、summary、terminal event 缺口。

最小修复：
- `ConversationRuntime.run` 增加统一 terminal path。
- finalizer 接收 `completed | failed | cancelled | paused`。
- pause 进入等待态，不跑 finalizer、不清空 loop。

验证：
- 长 run pause 后不出现 `agent_complete`，`agentLoop` 仍存在。
- resume 后继续同一次 run。
- model 抛异常时仍触发 failure finalizer、trace end、相关 hook。

### 2. cancel 不能真正中断正在执行的工具

分类：UI 和 runtime 都有入口，但工具层 abort 不完整。

关键路径：
- `src/main/agent/runtime/conversationRuntime.ts`
- `src/main/agent/runtime/toolExecutionEngine.ts`
- `src/main/tools/toolExecutor.ts`
- `src/main/protocol/dispatch/toolResolver.ts`

问题：
- cancel 当前只 abort inference controller。
- `ToolExecutionEngine` 没把 run-level signal 传入 ToolExecutor。
- protocol context 和 legacy helper 会创建新的、不会被 run cancel 影响的 signal。

最小修复：
- 给 `ToolExecutor.ExecuteOptions` 增加 `abortSignal`。
- signal 贯穿 `ToolExecutionEngine -> ToolExecutor -> ToolResolver -> ProtocolToolContext`。
- parallel tool batch 共享同一个 run signal。

验证：
- 执行长 Bash 或长 http_request，cancel 后子进程/请求被终止。
- cancel 后不再产生新的 tool result。

### 3. desktop chat 与 TaskManager 是两套运行状态

分类：已接入生产主链，状态所有权分裂。

关键路径：
- `src/main/app/agentAppService.ts`
- `src/main/task/TaskManager.ts`
- `src/main/ipc/task.ipc.ts`
- renderer task/session state 展示链路

问题：
- `agent:send-message` 直接进入 orchestrator。
- TaskManager 的 queue、semaphore、status 只由 task IPC 使用。
- renderer 仍可能混用 task state，导致同一会话一边 running、一边 idle。

最小修复：
- 二选一：
  - chat send/cancel/interrupt 统一进入 TaskManager。
  - 或 chat UI 完全移除 TaskManager 状态依赖，只看 session/runtime state。

验证：
- 真实发一条 chat，同时查 session status 和 task state，状态顺序一致。
- 并发 send/cancel 不会出现两个 owner 互相覆盖。

### 4. Bash 和 native protocol 权限语义不一致

分类：已接入生产主链，权限模型半迁移。

关键路径：
- `src/main/tools/toolExecutor.ts`
- `src/main/protocol/dispatch/toolResolver.ts`
- `src/main/protocol/dispatch/shadowAdapter.ts`
- `src/main/tools/modules/shell/bash.ts`

问题：
- core tool 是 `Bash`，但部分安全校验只判断小写 `bash`。
- ToolExecutor 顶层已经审批，resolver 又构造第二套 `canUseTool`，handler 内可能二次审批。

最小修复：
- ToolExecutor 入口统一 normalized tool name。
- 原始 toolName 只用于 registry dispatch 和 UI 展示。
- 顶层审批结果传给 resolver；同一 tool+args 不重复审批。

验证：
- `ToolExecutor.execute('Bash', { command: 'rm -rf /' })` 被 pre-validation 拦截。
- `Bash git status` safe path 不重复弹审批。
- denied 后不会进入 native handler 执行。

### 5. Skill allowed-tools 会自动扩权

分类：已接入执行态，安全边界不完整。

关键路径：
- `src/main/agent/skillTools/skillMetaTool.ts`
- `src/main/agent/runtime/runFinalizer.ts`
- `src/main/tools/toolExecutor.ts`
- `src/main/services/skills/skillParser.ts`

问题：
- Skill frontmatter 的 `allowed-tools` 会进入 `preApprovedTools`。
- finalizer 再加入 runtime preapproval。
- ToolExecutor 命中后跳过审批，缺少 trust gate。

最小修复：
- 只有 trusted/builtin skill 可自动扩权。
- project skill 想扩权必须弹一次明确授权。
- 校验 allowed-tools pattern grammar。

验证：
- project skill 写 `allowed-tools: Bash(git:*)` 后，首次 Bash 仍触发 permission request。
- trusted skill 扩权路径有明确审计记录。

### 6. swarm 运行可靠性不足

分类：生产 UI/IPC/parallel path 已接入，但路由、依赖、归并、取消半成品。

关键路径：
- `src/main/ipc/swarm.ipc.ts`
- `src/main/agent/parallelAgentCoordinator.ts`
- `src/main/agent/multiagentTools/spawnAgent.ts`
- `src/main/agent/resultAggregator.ts`

问题：
- `swarm:send-user-message` 持久化后总返回 delivered，但 parallel executor 没真实 inbox。
- `dependsOn` 只做拓扑分组，不等上游成功。
- aggregation 只按成功结果算成功率。
- stop all 是逐 agent best-effort cancel，不是 run-level cancel。

最小修复：
- parallel task 注册真实 inbox，executor 每轮 drain。
- 执行阶段维护 `successfulTaskIds/failedTaskIds`。
- failed task 也进入 aggregation 结果结构。
- 增加 run-level cancelled flag，abort running，mark pending cancelled。

验证：
- 给子 agent 发消息，executor 能收到。
- 上游 fail，下游标 blocked，不启动。
- 一成一败时 successRate 是 0.5。
- run-level cancel 后 pending agent 不再启动，trace 是 cancelled。

### 7. approval / task / context intervention 跨重启恢复不完整

分类：部分持久化，关键状态仍在内存。

关键路径：
- `src/main/services/core/repositories/PendingApprovalRepository.ts`
- `src/main/services/planning/taskStore.ts`
- `src/main/agent/todoParser.ts`
- `src/main/context/contextInterventionState.ts`

问题：
- plan/launch 共用 `markAllPendingAsOrphaned`，hydrate 顺序可能互相抢。
- taskStore 和 auto todo 是内存 Map。
- context intervention 是 singleton Map/Set，重启丢 pin/exclude/retain。

最小修复：
- approval orphan 按 `kind` 分区 hydrate。
- task/todo/intervention 落 session-scoped SQLite。
- 启动时 hydrate 到 runtime singleton。

验证：
- 同时存在 plan + launch pending，重启后两条都能恢复。
- todo/task 重启后仍能出现在 finalizer 和 UI。
- pin/exclude 重启后仍影响 `buildModelMessages()`。

### 8. auto-agent / replay observability 不足

分类：standard loop 已接 telemetry；auto-agent 和 replay 还不完整。

关键路径：
- `src/main/agent/agentOrchestrator.ts`
- `src/main/agent/orchestrator/autoAgentRunner.ts`
- `src/main/agent/subagentExecutor.ts`
- `src/main/evaluation/telemetryQueryService.ts`

问题：
- standard loop 创建 telemetry adapter。
- auto-agent/subagent 直接调用 model/tool，没有完整 turn/model/tool telemetry。
- replay 查询没有 join model_calls/events，更多是在解释“发生了什么”，不是“为什么这样调用工具”。

最小修复：
- AutoAgentRunner/SubagentExecutor 传 session-scoped telemetry adapter。
- replay join model decision、tool schema、permission trace、context compression event。

验证：
- 触发 auto-agent 后 DB 有 subagent model/tool rows。
- replay 能展示每次 tool call 前的模型决策和当时 tools/schema。

## 新会话提示词

```text
你在 /Users/linchen/Downloads/ai/code-agent 继续。
先按 AGENTS.md 做 memory bootstrap。
然后读 docs/plans/2026-04-27-agent-capability-p1-plan.md。

本轮只做 P1 的第 <N> 项：<finding 名称>。
先读 active path，再给最小 patch，不扩大到相邻 finding。
改完跑定向测试；没有现成测试就补最小 unit test。
输出按：改了什么、验证命令与结果、剩余风险、下一项是否可开始。

过程中可以开 Agent Team：
- 一个 agent 查 active path 和现有测试；
- 一个 agent 做最小 patch；
- 一个 agent 做回归验证或测试补齐。
主 agent 最后整合并复核。
```

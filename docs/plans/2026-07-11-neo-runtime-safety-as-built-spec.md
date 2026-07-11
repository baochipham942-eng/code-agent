# Neo 运行安全与执行可信度 as-built spec

> 时间范围：2026-07-04 至 2026-07-11  
> 事实基线：`origin/main@ef1ebe72a7f65a54e2f62c596a11a21cac2c7ee3`  
> 文档性质：已合入能力的产品与架构合同，不是未来设计稿

## 1. 本周产品结论

Neo 这一周的主线是把“能跑复杂任务”收紧为“每一轮由谁拥有、在哪个工作区执行、能做什么、如何证明完成”都有明确事实源。变化集中在六层：Native Run 身份与控制、工具执行安全、Agent Team 作用域、Goal 完成证据、权限与模型脚手架、`@neo` 协作与上下文经济性。

## 2. 已落地合同

### 2.1 Native Run 身份与控制所有权

- `runId` 是单次执行身份，`sessionId` 是会话与持久化身份，两者不能相同。
- `RunContext` 在创建时冻结 `runId / sessionId / workspace / cwd`；workspace 与 cwd 先解析真实路径，cwd 越界或路径解析失败时 fail-closed。
- `RunRegistry` 以 `runId` 为主键，并维护 session 唯一占用索引。同一 session 已有 active run 时，新请求在 SSE headers 发出前返回 `409 RUN_SESSION_CONFLICT`。
- cancel / pause / resume / steer 绑定精确 `RunHandle`。旧请求收尾只能注销自己持有的 handle，不能清理后来者。
- Native 本地工具、Bridge payload、文件 checkpoint、shell cwd、权限边界和 artifact 目录都消费同一份 RunContext。

详细合同见 [native-run-context.md](../architecture/native-run-context.md)。

### 2.2 工具执行安全与审计

- ToolCache 改为显式准入、默认不缓存。当前没有注册可缓存工具，连 Read 也不会绕过 handler 生命周期与 file-read/context-health 副作用。
- 缓存身份升级为 `tool-cache:v2 + workspace realpath SHA-256 + sessionId`；无法得到 canonical workspace 时不读不写缓存。
- 文件或 workspace 变化可按同一 scope 失效，旧 namespace 自然失效，不做破坏性清表。
- 工具执行账本在 `appendToolExecutionBegin` 之前递归脱敏 `headers / env / token / apiKey / secret / command` 等字段；账本仍是 fail-safe 审计面，写账失败不改变工具结果。
- SSE 工具调用只有在名称和参数都完整、参数 JSON 可解析时才进入执行。截断或残缺调用转成错误，不做猜测执行。

### 2.3 Agent Team / Swarm 运行作用域

- Team 子运行使用 `SwarmRunScope(sessionId, runId, treeId)`；agent id、消息、任务、审批、trace、取消和 UI 事件都带同一作用域。
- 活跃 Team scope 可携带 `parentNativeRunId`，ToolExecutor 会拒绝 parent Native run 不匹配的调用；该关联尚未形成 crash restore 的 rehydration 闭环。
- Agent 间工具先验证 caller scope 与 target scope。同 session 不同 Team run、不同 tree 或跨 session 的目标都会拒绝。
- coordinator 从进程级 singleton 收敛为按 scope 注册和查找；取消、approval、trace writeback 与结果聚合不再依赖“最近一次 run”。
- renderer store 和 IPC 只消费匹配当前 scope 的事件，旧 run 的晚到事件不能污染新 Team 视图。
- checkpoint restore 目前只有原语和单测，生产 `spawn_agent` / Agent Team 入口还未接 rehydration，因此不能宣称 crash recovery 已完成。

### 2.4 Goal 完成可信度

- 新增 `declare_deliverables`，让目标在执行阶段声明最终产物和 scratch 目录；后续完成申请按这份声明核验。
- 闸 0 对 `attempt_completion` 自报产物做磁盘存在性检查，对自报命令匹配本会话真实 Bash 记录；纯软目标没有证据会被有界打回。
- 闸 1 verifyCommand 和闸 2 Reviewer 区分“验证失败”与“基础设施不可用”。auth、provider unavailable、命令启动/kill 等 infra 问题进入显式降级链，不能伪装成任务质量失败。
- Goal gate 修复最多 2 次；artifact 修复达到硬上限后中止，避免长任务在验证和盲修之间无限循环。

### 2.5 权限档与模型脚手架

- 会话入口提供 `default / readOnly / acceptEdits / bypassPermissions` 四档；显式会话选择跨重启持久化，判定统一从 session effective mode 读取。
- `readOnly` 自动放行读操作，但写入和命令执行仍需确认；`bypassPermissions` 需要显式批准。
- cron、heartbeat 等无人值守会话即使继承到 bypass，也会钳制到不高于 `acceptEdits`。
- 模型能力档可以映射脚手架 profile。strong 档减少重复 thinking 注入、降低 audit nudge 频率并使用 compact repair instruction。
- scaffold profile 当前默认关闭；关闭时恒为 standard，生产默认行为不变。它是评测实验能力，不能写成已默认启用的优化。

### 2.6 `@neo` 协作入口与上下文经济性

- `@neo` 从逐任务审批重卡收敛为“直接开干 + 对话内清单 + topic 目录”；用户不再为每张卡重复选择模型和读写范围，现有 runtime safety guard 继续生效。
- topic 可以在其他会话显式续接。执行落在用户当前会话，topic 历史按轮注入；同一 topic 正在运行时拒绝并发续接。
- system prompt 中会频繁变化的 advisory/context 内容移到历史尾部 transient message，契约类 system 内容保留；工具表按名称稳定排序，减少 provider prefix cache 抖动。
- 大于阈值的 active tool result 先完整归档，再用确定性 placeholder 替换；归档失败保留原文，避免把“省 token”变成证据丢失。

详细决策见 [ADR-032](../architecture/decisions/ADR-032-request-shape-prefix-stability.md)、[ADR-034](../architecture/decisions/ADR-034-neo-tag-lightweight-conversational.md) 和 [ADR-035](../architecture/decisions/ADR-035-neo-tag-cross-session-topics.md)。

## 3. 关键事实源

| 合同 | 代码事实源 | 主要验证 |
|------|------------|----------|
| Native Run | `src/host/runtime/runContext.ts`、`runRegistry.ts`、`src/web/routes/agent.ts` | `runContextRegistry.test.ts`、`agentRouter.test.ts`、`toolExecutor.runIsolation.test.ts` |
| Tool safety | `toolCache.ts`、`toolExecutor.ts`、`toolExecutorHelpers.ts`、`sseStream.ts` | `toolCache.security.test.ts`、`toolExecutor.cacheSafety.test.ts`、`toolExecutor.executionLedger.test.ts`、`sseStream.snapshot.test.ts` |
| Team scope | `agentRunScope.ts`、`spawnGuard.ts`、`parallelAgentCoordinatorRegistry.ts`、`swarm.ipc.ts` | `*.scope.test.ts`、`swarmStore.test.ts`、`swarmIdentityContract.test.ts` |
| Goal trust | `goalEvidenceGate.ts`、`declareDeliverablesGate.ts`、`goalVerifyGate.ts`、`goalReviewGate.ts` | 对应 gate unit tests 与 artifact repair abort tests |
| Permissions | `permissions/modes.ts`、`toolPermissionClassification.ts`、`PermissionToggle.tsx` | `readOnlyMode.test.ts`、`sessionDefaultMode.test.ts`、`unattendedClamp.test.ts` |
| Scaffold | `scaffoldProfile.ts`、`constants/models.ts` | `scaffoldProfile.test.ts`、repair instruction snapshot tests |
| `@neo` / context | `neoTagRuntimeService.ts`、`topicRounds.ts`、`contextAssembly/messageBuild.ts`、`activeToolResultPrune.ts` | Neo continuation/topic tests、context assembly 与 prune tests |

## 4. 仍未完成的边界

1. Native RunContext 只覆盖 Native engine；Codex CLI、Claude Code 等外部 engine 还没有进入同一 RunRegistry。
2. Parallel checkpoint 尚未在生产 Agent Team 入口恢复，也没有 Native parent run rehydration。
3. ToolCache 已具备安全 namespace 与失效机制，但当前策略表为空，不能据此宣称有命中收益。
4. scaffold profile 与 compact repair instruction 均为默认关闭实验，需非劣评测后再决定是否 default-on。
5. RunContext 解决了运行所有权，stream snapshot 仍需单独按 session/run 升级身份；详见 [Neo 稳定性计划](./2026-07-11-neo-stability-trust-improvement-plan.md)。

## 5. 本周对应提交

- `64ceadf2f`：Goal 证据闸、deliverables 合同与修复止损。
- `2fcf1fe1f`：请求前缀稳定与 active tool-result prune。
- `d2cb78abc` / `c47d5c08d`：Reviewer / verify infra 故障诚实降级。
- `306d9ec43`：`@neo` 轻量对话化与跨会话 topic 续接。
- `ce0ee9e43`：SSE 工具完整性闸。
- `1db5986c7` / `47fe40a3d`：模型脚手架 profile 与 compact repair instruction，默认关闭。
- `b25d6f3f5`：Native Run、ToolCache、Agent Team scope 三条隔离主线。
- `1a364c87b`：四档会话权限与无人值守钳制。

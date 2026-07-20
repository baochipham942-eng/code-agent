# Neo 运行安全、Durable 执行与客户端收敛 as-built spec

> 时间范围：2026-07-04 至 2026-07-18
> 事实基线：`origin/main@6e4f8653a`
> 文档性质：已合入能力的产品与架构合同，不是未来设计稿

## 1. 本轮产品结论

Neo 这轮把“能跑复杂任务”继续收紧为“每一轮由谁拥有、以什么终态结束、客户端显示的是哪一次执行、如何恢复和证明完成”都有明确事实源。变化集中在九层：Durable Run 身份与终态、工具执行安全、Agent Team 恢复、Goal 完成证据、权限队列、renderer 事件投影、类型化 IPC、`@neo` 上下文经济性，以及桌面启动就绪边界。

## 2. 已落地合同

### 2.1 Durable Run 身份、控制所有权与终态真相

- `runId` 是单次执行身份，`sessionId` 是会话与持久化身份，两者不能相同。
- `RunContext` 在创建时冻结 `runId / sessionId / workspace / cwd`；workspace 与 cwd 先解析真实路径，cwd 越界或路径解析失败时 fail-closed。
- `RunRegistry` 以 `runId` 为主键，并维护 session 唯一占用索引。同一 session 已有 active run 时，新请求在 SSE headers 发出前返回 `409 RUN_SESSION_CONFLICT`。
- cancel / pause / resume / steer 绑定精确 `RunHandle`。旧请求收尾只能注销自己持有的 handle，不能清理后来者。
- Native 本地工具、Bridge payload、文件 checkpoint、shell cwd、权限边界和 artifact 目录都消费同一份 RunContext。
- Durable Run 的六表存储、owner epoch、attempt、event sequence、pending operation 和 terminal projection 已进入生产默认读取路径；终态事件与 durable projection 在同一事务提交。
- Native、Agent Team、Dynamic Workflow、外部 CLI 和 session replay 通过 `DurableRunReadService` 优先读取 durable fact；durable 终态映射为 session 的 `completed / error / interrupted`，不再由并行的 legacy 状态覆盖。
- Web `/api/agent` 把 start、success/failure、断连和 release 收进一个 `AgentDurableRouteRunLifecycle`。生命周期对象私有保存 terminal 状态，重复 terminal/release 幂等，断连统一提交 `run_cancelled`。
- 外部 CLI 的进程退出码只算 transport evidence。`completed` 必须同时有解析后的最终正文/结果；退出码为 0 但正文为空时提交 `failed`。Codex/Claude adapter、durable projection 和 session status 使用同一结论。

详细合同见 [native-run-context.md](../architecture/native-run-context.md)、[durable-run-kernel.md](../architecture/durable-run-kernel.md) 和 [external-engine-durable-lifecycle.md](../architecture/external-engine-durable-lifecycle.md)。

### 2.2 工具执行安全与审计

- ToolCache 改为显式准入、默认不缓存。当前没有注册可缓存工具，连 Read 也不会绕过 handler 生命周期与 file-read/context-health 副作用。
- 缓存身份升级为 `tool-cache:v2 + workspace realpath SHA-256 + sessionId`；无法得到 canonical workspace 时不读不写缓存。
- 文件或 workspace 变化可按同一 scope 失效，旧 namespace 自然失效，不做破坏性清表。
- 工具执行账本在 `appendToolExecutionBegin` 之前递归脱敏 `headers / env / token / apiKey / secret / command` 等字段；账本仍是 fail-safe 审计面，写账失败不改变工具结果。
- SSE 工具调用只有在名称和参数都完整、参数 JSON 可解析时才进入执行。截断或残缺调用转成错误，不做猜测执行。

### 2.3 Agent Team / Swarm 运行作用域

- Team 子运行使用 `SwarmRunScope(sessionId, runId, treeId)`；agent id、消息、任务、审批、trace、取消和 UI 事件都带同一作用域。
- Team scope 的 `parentNativeRunId` 同时进入 durable envelope/checkpoint；live 与 rehydrated coordinator 都保留 parent linkage，ToolExecutor 会拒绝 parent Native run 不匹配的调用。
- Agent 间工具先验证 caller scope 与 target scope。同 session 不同 Team run、不同 tree 或跨 session 的目标都会拒绝。
- coordinator 从进程级 singleton 收敛为按 scope 注册和查找；取消、approval、trace writeback 与结果聚合不再依赖“最近一次 run”。
- renderer store 和 IPC 只消费匹配当前 scope 的事件，旧 run 的晚到事件不能污染新 Team 视图。
- Agent Team checkpoint 已接入统一 startup recovery：恢复 coordinator、completed results、mailbox、pending approval、owner epoch 与 protocol-native execution port；completed child 不重启，重复 dispatch 由稳定 key 拒绝。
- crash recovery 的承诺只覆盖已持久化且能安全判定的状态。无法证明幂等的未决外部副作用仍进入 `requiresHumanConfirmation`，不会猜测重放。

### 2.4 Goal 完成可信度

- 新增 `declare_deliverables`，让目标在执行阶段声明最终产物和 scratch 目录；后续完成申请按这份声明核验。
- 闸 0 对 `attempt_completion` 自报产物做磁盘存在性检查，对自报命令匹配本会话真实 Bash 记录；纯软目标没有证据会被有界打回。
- 闸 1 verifyCommand 和闸 2 Reviewer 区分“验证失败”与“基础设施不可用”。auth、provider unavailable、命令启动/kill 等 infra 问题进入显式降级链，不能伪装成任务质量失败。
- Goal gate 修复最多 2 次；artifact 修复达到硬上限后中止，避免长任务在验证和盲修之间无限循环。

### 2.5 权限档与模型脚手架

- 会话入口提供 `default / readOnly / acceptEdits / bypassPermissions` 四档；显式会话选择跨重启持久化，判定统一从 session effective mode 读取。
- `readOnly` 自动放行读操作，但写入和命令执行仍需确认；`bypassPermissions` 需要显式批准。
- cron、heartbeat 等无人值守会话即使继承到 bypass，也会钳制到不高于 `acceptEdits`。
- renderer 权限队列按 session 分桶，并保留独立 `global` 队列；当前 session 和 global 同时有请求时只弹出当前项，不能破坏性消费下一队列。
- 带 sessionId 的 `agent_complete / agent_cancelled / error / stream_end` 只清理该 session 的 pending/queued 请求，不误伤其他 session 或 global 请求。
- `Esc` 关闭审批卡必须走 `AGENT_PERMISSION_RESPONSE=deny` 并复用防重 guard；IPC 发送失败时恢复卡片，禁止只清 UI 后让 host 等待超时。
- 模型能力档可以映射脚手架 profile。strong 档减少重复 thinking 注入、降低 audit nudge 频率并使用 compact repair instruction。
- scaffold profile 当前默认关闭；关闭时恒为 standard，生产默认行为不变。它是评测实验能力，不能写成已默认启用的优化。

### 2.6 `@neo` 协作入口与上下文经济性

- `@neo` 从逐任务审批重卡收敛为“直接开干 + 对话内清单 + topic 目录”；用户不再为每张卡重复选择模型和读写范围，现有 runtime safety guard 继续生效。
- topic 可以在其他会话显式续接。执行落在用户当前会话，topic 历史按轮注入；同一 topic 正在运行时拒绝并发续接。
- system prompt 中会频繁变化的 advisory/context 内容移到历史尾部 transient message，契约类 system 内容保留；工具表按名称稳定排序，减少 provider prefix cache 抖动。
- 大于阈值的 active tool result 先完整归档，再用确定性 placeholder 替换；归档失败保留原文，避免把“省 token”变成证据丢失。

详细决策见 [ADR-032](../architecture/decisions/ADR-032-request-shape-prefix-stability.md)、[ADR-034](../architecture/decisions/ADR-034-neo-tag-lightweight-conversational.md) 和 [ADR-035](../architecture/decisions/ADR-035-neo-tag-cross-session-topics.md)。

### 2.7 Renderer 事件投影与工具卡身份

- permission、task progress、tool execution 三组副作用已抽成可直接测试的纯事件投影核心，React effect 只负责订阅 IPC 和注入 store 依赖。
- 事件先按 session scope 过滤；terminal 事件只清当前 session 的临时状态，旧 session 的晚到事件不能污染当前会话。
- 工具开始、增量和结果以 `toolCallId` 为稳定身份。已有稳定 id 时禁止按工具名猜测；只有单个、未完成、同名 streaming placeholder 时才允许一次受限 fallback。
- 同一轮出现多个同名工具时，`tool_call_end` 只写回 id 精确匹配的卡片；找不到匹配只记录诊断，不把结果绑到邻近卡片。

### 2.8 类型化 IPC 与事件基础设施

- `IpcInvokeHandlers` 已覆盖 Skill 域 28 个通道；renderer 统一经 `invokeSkillIPC()` 取得 `Parameters/ReturnType` 约束，Skills 设置页和推荐入口不再维护各自的 `unsafeInvoke` 类型逃逸。
- `src/shared/ipc/protocol.ts` 只保留仍有消费方的 `IPCResponse/createErrorResponse`。真实 action 合同由各 domain handler、`IpcInvokeHandlers` 和逐步迁移的 zod schema 承担。
- 事件基础设施的真实边界是 `EventBus + InternalEventStore + Mailbox`。零调用方的 `ControlStream/EventReplay` 假 seam 和孤儿 `withTimeout` helper 已删除，不再出现在架构承诺里。

### 2.9 桌面启动与更新后首启

- webServer launcher 负责开启 V8 compile cache，再加载 payload；启动阶段同时在 webServer、renderer 和 Tauri shell 留结构化 timing marks，用来区分壳、服务初始化和首屏成本。
- Tauri 已清理过 stale port 的 release 启动不再让 webServer 重复执行 `lsof`；首屏不需要的 chat 重库、markdown 和 swarm topology 继续按用户打开路径 lazy load。
- `install_update` 在新 bundle 落盘、restart 之前 best-effort 预热 compile cache。预热使用隔离临时 data dir，并通过 SQLite online backup 读取真库快照；cache 写真实目录。失败或 20 秒超时只退化为冷启动，不能阻塞重启。
- `/api/health` 仍只代表 shell 可导航；远程 capability bootstrap 和 durable recovery 在后台完成，durable 未 ready 时 agent route fail-closed。

## 3. 关键事实源

| 合同 | 代码事实源 | 主要验证 |
|------|------------|----------|
| Durable Run | `src/host/runtime/runContext.ts`、`runRegistry.ts`、`durableRunKernel.ts`、`src/host/app/durableRunReadService.ts`、`src/web/routes/agentDurableRouteLifecycle.ts` | durable kernel/repository gold、`agentDurableRouteLifecycle.test.ts`、`agentRouter.test.ts`、`sessionsRouter.test.ts` |
| Tool safety | `toolCache.ts`、`toolExecutor.ts`、`toolExecutorHelpers.ts`、`sseStream.ts` | `toolCache.security.test.ts`、`toolExecutor.cacheSafety.test.ts`、`toolExecutor.executionLedger.test.ts`、`sseStream.snapshot.test.ts` |
| Team scope/recovery | `agentRunScope.ts`、`spawnGuard.ts`、`parallelAgentCoordinatorRegistry.ts`、`durableRecoveryDispatcher.ts`、`swarm.ipc.ts` | scope tests、durable Team recovery tests、`swarmStore.test.ts`、`swarmIdentityContract.test.ts` |
| Goal trust | `goalEvidenceGate.ts`、`declareDeliverablesGate.ts`、`goalVerifyGate.ts`、`goalReviewGate.ts` | 对应 gate unit tests 与 artifact repair abort tests |
| Permissions | `permissions/modes.ts`、`toolPermissionClassification.ts`、`usePermissionQueueEffects.ts`、`appStore.ts`、`useKeyboardShortcuts.ts` | permission mode tests、`usePermissionQueueEffects.test.ts`、`appStore.test.ts`、`useKeyboardShortcuts.test.tsx` |
| Renderer event projection | `useToolExecutionEffects.ts`、`useTaskProgressEffects.ts`、`agentEventSession.ts` | 对应 renderer hook tests，含同名 toolCall 与跨 session 晚到事件用例 |
| Typed IPC/eventing | `src/shared/ipc/handlers.ts`、`src/renderer/services/invokeSkillIPC.ts`、`src/host/services/eventing/bus.ts`、`internalStore.ts` | skill 调用方 typecheck、eventing 单测与零残留引用检查 |
| Scaffold | `scaffoldProfile.ts`、`constants/models.ts` | `scaffoldProfile.test.ts`、repair instruction snapshot tests |
| `@neo` / context | `neoTagRuntimeService.ts`、`topicRounds.ts`、`contextAssembly/messageBuild.ts`、`activeToolResultPrune.ts` | Neo continuation/topic tests、context assembly 与 prune tests |
| Workflow process sandbox | `scriptRuntime/sandbox.ts`、`capabilityManifest.ts`、`agentWorktree.ts` | `processSandbox.security.test.ts`、`capabilityManifest.test.ts`、`agentWorktreeSymlink.test.ts` |
| Desktop startup | `src/web/webServerBootstrap.cjs`、`src/web/webServer.ts`、`src-tauri/src/main.rs`、renderer `boot:*` marks | compile-cache tests、Rust tests/check、desktop shell smoke 与 boot timing logs |

## 4. 仍未完成的边界

1. `stream-snapshot.json` 仍需单独按 workspace/session/run/turn 升级身份；Durable Run 不能替代流式正文快照隔离。详见 [Neo 稳定性计划](./2026-07-11-neo-stability-trust-improvement-plan.md)。
2. Codex CLI 与 Claude Code 已支持带稳定 session id 的恢复；MiMo Code 仍为 `non_resumable`，Kimi Code 仍为 `unknown`，崩溃后只能 `requires_review`。
3. 长会话 500/1000 回合的结构化性能金标、停止收敛和滚动锚点 release gate 仍未完成。
4. ToolCache 已具备安全 namespace 与失效机制，但普通工具策略表仍为空；MCP long task 的 provider-operation 证明不能外推成通用工具缓存收益。
5. scaffold profile 与 compact repair instruction 均为默认关闭实验，需非劣评测后再决定是否 default-on。
6. compile-cache warmup 只覆盖应用内更新后的 restart，并且设计为 best-effort；全新安装、手工替换 App 和 cache 被清理后的冷启动仍需要真实签名包 dogfood 证据。

## 5. 对应提交

- `64ceadf2f`：Goal 证据闸、deliverables 合同与修复止损。
- `2fcf1fe1f`：请求前缀稳定与 active tool-result prune。
- `d2cb78abc` / `c47d5c08d`：Reviewer / verify infra 故障诚实降级。
- `306d9ec43`：`@neo` 轻量对话化与跨会话 topic 续接。
- `ce0ee9e43`：SSE 工具完整性闸。
- `1db5986c7` / `47fe40a3d`：模型脚手架 profile 与 compact repair instruction，默认关闭。
- `b25d6f3f5`：Native Run、ToolCache、Agent Team scope 三条隔离主线。
- `1a364c87b`：四档会话权限与无人值守钳制。
- `c003699a6` 至 `8a3083350`：Durable Run kernel、Native/Team/Workflow/External/MCP 恢复切片、S9 真实进程矩阵与 `durable_preferred` 生产切换。
- `d2aa0d317` / `12bbe7fdf`：启动分段打点、首屏 lazy load、端口清理去重与更新后 compile-cache 预热。
- `cacb650e3` / `b472d2fce`：删除假 eventing/IPC seam，并把 Skill 域 28 通道纳入共享类型合同。
- `c822b8227`：permission/task/tool 三组 renderer effects 抽成可测事件投影核心。
- `bd709cc4e` / `e3ecce5d9` / `2b66fc79c` / `6e4f8653a`：Web durable lifecycle、权限队列、同名工具卡、断连事件和外部引擎空输出终态收敛。

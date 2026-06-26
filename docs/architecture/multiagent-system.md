# 多 Agent 编排系统架构设计

> 核心代码：
> - `src/host/agent/autoAgentCoordinator.ts` — 唯一的多 Agent 协调器
> - `src/host/agent/parallelAgentCoordinator.ts` — 并行 Agent 协调器（含 SharedContext）
> - `src/host/agent/taskDag.ts` — DAG 依赖调度
> - `src/host/agent/multiagentTools/` — spawnAgent / sendInput / waitAgent 等工具

## 0. 通信级别模型 (Communication Levels)

借鉴 Hermes Agent 的 L0-L3 分级，对现有多 Agent 通信模式进行显式建模。
选择依据：**按任务需求选最低够用的级别**，级别越低隔离越强、调试越容易。

### 级别定义

| Level | Name | 描述 | 适用场景 |
|-------|------|------|----------|
| **L0** | Isolated | 完全隔离，无数据共享，父 agent 手动中继 | 独立子任务（代码生成、文档生成） |
| **L1** | Result Passing | 上游输出自动注入下游 context | 流水线式任务（分析→编码→测试） |
| **L2** | Shared Context | 共享 KV 存储，coordinator 中转读写 | 并行任务需发现共享（并行搜索→合成） |
| **L3** | Live Dialogue | Agent 间 turn-based 对话 | 辩论/交叉审查（未实现，P2 交叉验证是简化版） |

### 代码映射

```
L0 — executeParallel() 中的并行 agent，各自独立执行
L1 — executeSequential() 的 previousOutput 链式传递
L2 — ParallelAgentCoordinator.SharedContext（findings/files/decisions KV）
L3 — 未实现（Codex MCP P2 crossVerify 是 L3 雏形）
```

### 策略与级别的对应

| ExecutionStrategy | 默认级别 | 说明 |
|-------------------|---------|------|
| `direct` | L0 | 单 agent，无需通信 |
| `sequential` | L1 | 上游结果自动注入下游 |
| `parallel` | L0 + L2(可选) | 主 agent 串行(L1) → 并行 agent 隔离(L0)，可开 SharedContext 升到 L2 |

### 设计原则

1. **不做 L3** — Agent 间直接对话引入非确定性交互，调试成本极高。需要交叉验证时走 MCP P2
2. **L2 仅 coordinator 中转** — 不暴露自由读写 KV，避免共享可变状态的一致性问题
3. **升级需显式** — 默认走 L0/L1，只有 `enableSharedContext: true` 时才升到 L2

## 0.0 2026-04-27 产品化加固状态

这轮把 Agent Team 的几个“不可靠但看起来能用”的点补成了明确 contract。当前还没有完成全量 swarm runtime 收敛，但 P1 blocker 已不再成立。

| 能力 | 当前状态 | 关键文件 / 测试 |
|------|----------|----------------|
| parallel executor inbox | `send_input` 先写 SpawnGuard agent queue；找不到时会退到 `ParallelAgentCoordinator` 的 task inbox，executor 迭代前可 drain | `src/host/agent/multiagentTools/sendInput.ts`、`tests/unit/agent/sendInput.test.ts` |
| dependsOn gate | 下游只在所有依赖成功后启动；上游失败时下游标 `blocked`，不再继续跑 | `parallelAgentCoordinator.ts`、`tests/unit/agent/parallelAgentCoordinator.test.ts` |
| aggregation shape | 成功、失败、blocked、cancelled agent 都进入结果结构；`successRate` 按总任务数计算 | `src/host/agent/resultAggregator.ts`、`tests/unit/agent/resultAggregator.test.ts` |
| run-level cancel | `abortAllRunning()` 会中止 running task，并把 pending task 标 cancelled；`swarm:cancel-run` 同时取消 plan/launch approval、SpawnGuard 和 parallel coordinator | `parallelAgentCoordinator.ts`、`src/host/ipc/swarm.ipc.ts` |
| send_input interrupt | schema 已移除未实现的 `interrupt` 参数，避免承诺抢占式中断 | `src/host/agent/multiagentTools/sendInput.ts` |

当前边界：

- UI 上仍可能看到 Agent Team、SpawnGuard、hybrid swarm、parallel coordinator 多条历史路径并存；工程债文档把这条列为长期收敛项。
- 本轮闭环主要是 unit 级和 IPC 级；真实多 agent 端到端 smoke 仍应单独补。
- 生产口径里，parallel executor 才是 dependsOn / inbox / aggregation 的主要事实源，legacy/hybrid 只按兼容路径理解。

## 0.0.1 2026-05 Browser / Computer 多 agent 隔离

5/8 之后，Agent Team 的浏览器和桌面工具不再共享一个无差别全局 surface。父 agent 调度子 agent 时会把 `agentId` 注入 `ToolContext`，Browser/Computer 相关工具按 agent 维度隔离状态、限制资源并串行化桌面写动作。

| 能力 | 当前状态 | 关键文件 / 验证 |
|------|----------|----------------|
| Per-agent BrowserService pool | 命名 agent 有独立 BrowserService；cookie/localStorage/sessionStorage 不串号；命名 agent 有 LRU 上限 | `src/host/services/infra/browserPool.ts`、`src/host/services/infra/browserService.ts`、`tests/smoke/*browser-pool*` |
| Ephemeral Chromium semaphore | 临时浏览器启动通过 FIFO semaphore 限流，避免多个子 agent 同时拉起 Chromium | `src/host/services/infra/playwrightLaunchSemaphore.ts` |
| ToolContext agentId | `spawn_agent` / subagent dispatch 将 `agentId` 传给工具执行上下文，Browser/Computer 能按 owner 取资源 | `src/host/agent/multiagentTools/spawnAgent.ts`、`src/host/tools/toolExecutor.ts` |
| ComputerSurface write lock | `type/click/key/clipboard` 等写动作串行执行；observe/launch 这类读或准备动作不阻塞 | `src/host/services/desktop/computerSurfaceLock.ts` |
| 新 Computer 原语 | 支持 `mouse_down/up`、`open_application`、`write_clipboard`、`computer_batch`、`hold_key`、`triple_click`、`cursor_position` | `src/host/tools/vision/computerUse.ts` |
| targetApp 截图裁剪 | 多 agent 模式下可对目标 app 截图裁剪并显示 escalated warning，减少无关桌面上下文泄漏 | `src/host/tools/vision/computerUse.ts`、browser/computer smoke |
| effectiveSignal 透传 | 子 agent cancel / abort signal 下沉到 `modelRouter.inference`，减少取消后模型请求继续跑 | `src/host/model/modelRouter.ts` |

产品口径：这是并发隔离和隐私边界，不改变单 agent 默认浏览器/桌面语义。Browser 隔离 smoke 是证据，不单独作为功能入口。

## 0.0.2 2026-05-13 Custom Agents + Permission Inheritance

本轮把多 Agent 的两个基础承诺补实：用户能定义可复用 agent，subagent 不能绕过父级权限。

### Custom Agent Registry

自定义 agent 采用 Claude Code 兼容的 Markdown frontmatter + 正文格式，落盘位置是用户级 `~/.code-agent/agents/*.md` 和项目级 `<cwd>/.code-agent/agents/*.md`。`agentRegistry` 是新的单一来源，合并顺序为 project > user > builtin。

| 能力 | 当前状态 | 关键文件 / 验证 |
|------|----------|----------------|
| 三层 agent 合并 | builtin、user、project 同名时按 project > user > builtin 覆盖；需要原始内置定义时走 `getBuiltinAgent()` | `src/host/agent/agentRegistry.ts`、`src/host/agent/agentDefinition.ts` |
| Double-buffer 热加载 | chokidar 触发重扫时先构建 next map，再原子替换当前 registry，避免 in-flight spawn 读到半填充状态 | `src/host/agent/agentRegistry.ts` |
| Spawn / Task 共用 registry | `spawn_agent` 和 Task 工具不再只读 `PREDEFINED_AGENTS`；错误提示和 validation 使用最新 agent id 集 | `src/host/agent/multiagentTools/spawnAgent.ts`、`src/host/tools/modules/multiagent/task.ts` |
| CLI / UI 暴露 | `ca list-agents` 显示 builtin/user/project 来源；renderer 通过 `agents:list` 和 `agents:changed` 刷新 StatusBar AgentSwitcher | `src/cli/commands/listAgents.ts`、`src/host/ipc/agentRegistry.ipc.ts`、`src/renderer/components/StatusBar/AgentSwitcher.tsx` |

当前边界：`activeAgentId` 已进入 renderer store 和切换 UI，但自动作为下一轮默认 spawn role 的 chat send pipeline 还留在后续小切片。

### Subagent Permission Inheritance

权限继承是 M2-Task 5 的 partial 版本：先接通 `parentContext` 和用户 deny 级联，AgentTask/profile matrix 暂不一起扩。

| 能力 | 当前状态 | 关键文件 / 验证 |
|------|----------|----------------|
| 三档继承模式 | `strict-inherit` / `child-narrow` / `independent`；默认 `strict-inherit` | `src/host/agent/childContext.ts`、`src/shared/contract/settings.ts` |
| 权限合并算法 | 子 tools = parent tools ∩ child declared；deny = parent deny ∪ child deny；permission mode 取更严格者 | `tests/agent/permissionInheritance.test.ts` |
| 用户规则级联 | `settings.permissions.deny/ask/allow` 经 `UserConfigSource` 进入 GuardFabric，主 agent 和 subagent 同时生效 | `src/host/permissions/userConfigSource.ts`、`src/host/permissions/index.ts` |
| Spawn parentContext | `spawn_agent` 注入父级权限、工具和 role 信息；`subagentExecutor` 可为旧 caller auto-derive parentContext | `src/host/agent/multiagentTools/spawnAgent.ts`、`src/host/agent/subagentExecutor.ts` |
| Reviewer / readonly 保护 | reviewer / readonly 父 agent 禁止派生带写能力的 coder 类子 agent | `tests/permission-inheritance/scenarios.test.ts` |
| 设置入口 | General settings 暴露继承模式和用户 deny/ask/allow 规则 | `src/renderer/components/features/settings/tabs/GeneralSettings.tsx` |

验证口径：`feature/permission-inheritance` 分支覆盖 52/52 权限测试，包括 26 条 AC 场景、6 条 legacy grandfathering、20 条 unit。产品口径里，它属于多 agent 安全语义升级：从"用户以为会继承"变成"运行时强制继承"。

## 0.0.3 2026-05-13 取消级联（Cancellation Cascading）

`feature/cancellation-cascading` 分支把多 agent 的取消语义补成可解释闭环：父级取消向下穿透，子级失败/超时只熔断自身，单个 subagent 出错不再拖垮整个 Agent Team。

### CancellationReason 契约

`src/shared/contract/cancellation.ts` 把取消原因分成两类，决定是否级联：

| 分类 | reason | 行为 |
|------|--------|------|
| `CASCADE_REASONS` | `user-cancel` / `session-switch` / `parent-cancel` | 触发 `spawnGuard.cancelAll()`，向下穿透到全部子 agent |
| `NON_CASCADE_REASONS` | `child-error` / `timeout` / `idle-timeout` / `budget-exceeded` | 只影响单个 agent，兄弟不受影响 |

### 四阶段 Shutdown + Idle Watchdog

| 能力 | 当前状态 | 关键文件 |
|------|----------|---------|
| 四阶段 initiateShutdown | Signal（`abort(reason)`）→ Grace（5s 等 in-flight 工具收尾）→ Flush（2s 经 TeamManager 持久化 findings）→ Force（返回 partial results） | `src/host/agent/shutdownProtocol.ts` |
| Idle watchdog | `subagentExecutor` 每 `IDLE_CHECK_INTERVAL`（5s）轮询，`IDLE_TIMEOUT`（2 分钟）无 stream/progress 则 `abort('idle-timeout')` | `src/host/agent/subagentExecutor.ts`、`src/shared/constants/timeouts.ts`（`CANCELLATION_TIMEOUTS`） |
| 父子信号单向桥接 | `createChildAbortController` 把 parent abortSignal 与内部 timeout 汇入子控制器；子控制器 abort 不反向传播到 parent/sibling，对应 NON_CASCADE 语义 | `src/host/agent/subagentExecutor.ts` |
| Per-agent Stop UI | `SwarmMonitor` 每个 agent 卡片可独立 Stop，走 `swarm:cancel-agent` IPC（`spawnGuard.cancel` 或 `parallelCoordinator.abortTask`），触发 `agentCancelled` 但不级联兄弟 | `src/renderer/components/features/swarm/SwarmMonitor.tsx`、`src/host/ipc/swarm.ipc.ts` |

验证口径：`feature/cancellation-cascading` 分支带 AC 测试套件覆盖 cascade / non-cascade 场景。产品口径里，它把多 agent 取消从"取消一个可能误伤一片"升级为"取消语义按 reason 显式分层"。

## 0.0.4 2026-05-29 Dynamic Workflow — 命令式脚本编排运行时

这轮新增**第 4 条多 Agent 路径**：在既有「声明式 stage-DAG」之外，加一条「模型当场写 JS 编排脚本 → 受限 worker 沙箱后台确定性执行」的命令式运行时（复刻 Claude Code Workflow）。声明式 `workflow_orchestrate` 保留并存。

| 路径 | 模型契约 | 控制流 | 适用 |
|------|----------|--------|------|
| `spawn_agent` / Task | 逐轮决定 | 模型每轮选下一步 | 即兴拆分 |
| `workflow_orchestrate`（声明式）| 选模板 / 填 `stages[]` | 运行时按 DAG 跑 | 固定模板流水线 |
| **`workflow`（命令式，新）** | 当场写 JS 脚本 | 脚本自持 loop/branch/中间变量 | 几十上百扇出 + 对抗验证 + resumable |

| 能力 | 当前状态 | 关键文件 |
|------|----------|---------|
| 5 原语脚本运行时 | `agent/parallel/pipeline/phase/log` + `args`/`budget`，worker_threads 沙箱（`eval` 字符串规避打包陷阱）+ 超时/内存上限 | `src/host/agent/scriptRuntime/{sandbox,primitives,runService}.ts` |
| forced 结构化输出 | `agent({schema})`=单轮 forced tool_choice 取稳定判断值（命令式控制流地基）；无 schema=完整 SubagentExecutor loop | `…/agentBridge.ts`、`InferenceOptions.toolChoice` |
| 多 run 隔离 | runService 自持 activeRuns，**破 swarm 单 active-run 假设**（ADR-009/010）；agent() 直连 executor 绕 4 条灌历史高层入口 | `…/runService.ts`、`…/agentBridge.ts` |
| provider-aware 并发闸 | 全局上限 16，确认 provider capacity 后再占全局槽，防 zhipu/3 饿死 | `…/concurrencyGate.ts` |
| token budget + 三档工具 | per-run BudgetTracker（reserve/commit 消 TOCTOU）+ readonly/edit/full 工具档 + 并行写护栏 | `…/budget.ts`、`…/toolProfiles.ts` |
| UI（进度树/审批卡/触发）| WorkflowPanel/InlineMonitor + 跑前审批卡（4 维度成本）+ `/workflow` gen8 carve-out；专用 IPC bridge | `src/renderer/components/features/workflow/*`、`src/host/ipc/workflow.ipc.ts`、`src/host/agent/workflowLaunchApproval.ts` |
| resumable | 源码重放 + agent 结果缓存（不序列化 VM 状态）；专用表 `workflow_runs`/`workflow_run_calls`；命中 0 token | `WorkflowJournalRepository`、`…/scriptValidator.ts`（确定性加固）|

安全边界：威胁模型是**半信任模型代码**（非对抗者）；已知缺口 = worker `new AsyncFunction` 字符串求值逃逸（`isolated-vm` 硬沙箱排后单独排期）。完整设计见 **[dynamic-workflow.md](./dynamic-workflow.md)**。

## 0.0.5 2026-06-01 Agent Neo Product Closure — 多 Agent 产品层级

产品闭环阶段把多 Agent 入口按用户心智重新分层，避免 prompt、UI 和测试各说一套。

| 入口 | 产品层级 | 当前口径 |
|------|----------|----------|
| Chat | default | 普通交互任务入口。 |
| `/workflow` / `workflow` | default | 复杂长任务默认路径，支持脚本控制流、恢复、取消、暂停和后台。 |
| Agent Team | expert | 并行审计、专题分解和只读 evidence gathering，默认不让子 agent 自动改代码。 |
| `spawn_agent` | compatibility | 单个子 agent 委派和历史调用兼容。 |
| `workflow_orchestrate` | compatibility | 声明式 stage-DAG 兼容路径，不抢 `/workflow` 的命令式默认口径。 |

配套回归：

- `promptRegression.test.ts` 覆盖当前 Task / ToolSearch / file tool 指引。
- `workflowOrchestrate.legacy.test.ts` 保证旧 role 归一后仍能跑 compatibility path。
- `spawnGuard` 继续禁止子 agent 再开 workflow 类工具，避免多层长任务互相套娃。

## 0.0.6 2026-06 SubagentStop trace 入口（GAP-012，PR #196）

子 agent 结束时触发的 `SubagentStop` hook 此前缺少回溯入口——无法把单次 subagent 的 stop 事件关联回 swarm 里的具体 agent。本轮给 `SubagentStop` hook context 补上 `agentId`，作为 swarm trace 的查询入口，并新增 `HOOK_SUBAGENT_ID`（及 `HOOK_SUBAGENT_TYPE`）环境变量给 command hook 使用；`subagentExecutor` 里 4 个 `triggerSubagentStop` 调用点全部带上 `agentTask.id`。

关键文件：`src/host/agent/subagentExecutor.ts`、`src/host/protocol/events/hookTypes.ts`。细节见 [极客时间差距修复 spec](../specs/2026-06-02-geektime-gap-remediation.md)。

## 0.0.7 2026-06 子代理 skills 全文预注入（GAP-011，PR #194）

课程"方向 A"：让自定义 agent 可以预装领域知识。`SubagentConfig` / `AgentCore` / `CoreAgentConfig` 新增 `skills?: string[]` 字段，自定义 agent `.md` frontmatter 支持 `skills:` 列表，从而定义"预装领域知识"的专家子代理。

- spawn 时 `buildSubagentSkillsBlock`（`src/host/services/skills/subagentSkillInjection.ts`）把 SKILL.md 全文一次性拼进子代理 system prompt 的 `<preloaded_skills>` 块——**全量加载**，非 Skill 元工具的渐进式披露。
- 与 GAP-001 fork 限权**正交**：注入 skill 只加知识，不扩张子代理 `availableTools` 的权限边界。
- 链路：`agentMdLoader → CoreAgentConfig → toFullAgentConfig → spawnAgent / executeFromDefinition → SubagentConfig → subagentExecutor`。

关键文件：`src/host/services/skills/subagentSkillInjection.ts`、`src/host/agent/subagentExecutor.ts`、`src/host/agent/subagentExecutorTypes.ts`。细节见 [极客时间差距修复 spec](../specs/2026-06-02-geektime-gap-remediation.md)。

## 0.0.8 2026-06-03 Swarm goal + 主动性合流（P4）

goal 模式接入 swarm 并行执行，并把角色主动性的 advance 收进 goal-based 执行做完成校验。设计见 [swarm-goal.md](../designs/swarm-goal.md)，产品合同见 [批次 spec](../specs/2026-06-04-swarm-project-space-and-capability-batch.md)。

| 能力 | 当前口径 | 关键文件 |
|------|----------|---------|
| `GoalContract.allowSwarm` | 默认 true；advance→goal 路径强制 false（防 token burn）；开启时以 dynamic-workflow scriptRuntime 为编排基底，复用 BudgetTracker / ConcurrencyGate / SerialWriteGate，不引入新并行运行时 | `src/host/agent/goalModeController.ts`、`src/shared/contract/appService.ts` |
| 三层闸只在总体层 | goal 闸1/2/3 语义不变；子任务校验交给脚本 verification 阶段；不做子级 DAG / 子级闸（P4.2+ 再做） | `src/host/agent/goalModeController.ts` |
| 预算双向打通 | swarm 子运行 token 经 `ToolResult.metadata.tokensSpent` 上报回灌 goal 预算；`SWARM_GOAL` 常量约束总预算分数与 advance 预算（200k token / 30 turn） | `src/host/agent/runtime/contextAssembly/deferredToolPreload.ts`、`src/shared/constants/agent.ts`（`SWARM_GOAL`） |
| 闸2 / delivery critic 降级链 | powerful tier 无 key 时软评审/交付 critic 复用同一模型可用性降级链 | `src/host/agent/goalModeController.ts` |

## 0.0.9 2026-06-03 Swarm 执行层护栏（P1-2 / P1-4）

延续 0.0.3 取消级联契约，给 spawn 嵌套与跨 agent 协调补结构化失败语义和孤儿回收。无独立设计文档，as-built 见 [批次 spec](../specs/2026-06-04-swarm-project-space-and-capability-batch.md)。

| 能力 | 当前口径 | 关键文件 |
|------|----------|---------|
| 结构化失败码 | NON_CASCADE 新增 `depth-limit` / `child-refusal` / `child-max-tokens` / `parent-gone`；`routeFailureCode()` 路由为 throw / degrade / retry / surface | `src/shared/contract/cancellation.ts`、`src/host/agent/subagentExecutorTypes.ts` |
| spawn 深度截断 | `SPAWN_GUARD.MAX_DEPTH=1` / `MAX_AGENTS=6`，执行层 2 线防御（非工具黑名单）；越界注入 depth-limit prompt | `src/host/agent/multiagentTools/spawnAgent.ts`、`src/shared/constants/agent.ts`（`SPAWN_GUARD`） |
| SharedContext 新鲜度 | `lastUpdated` 版本戳 + `isStale` 判定，避免读到过期共享态 | `src/host/agent/parallelAgentCoordinator.ts` |
| Agent Inbox 桥接 | `peekUnifiedInbox()` 只读统一查询入口，非破坏（不碰 write/drain 路径） | `src/host/agent/agentInbox.ts`、`src/host/agent/spawnGuard.ts` |
| 孤儿回收父探活 | 后台 detached 子代理每轮迭代探活父 run（`isParentRunAlive`），父已不在则自 abort（`parent-gone`）——结构化并发回收，非 heartbeat/WeakRef | `src/host/agent/orphanLiveness.ts`、`src/host/agent/subagentExecutor.ts` |

## 0.0.10 2026-06-04 Swarm 协作可见性（P1-3）

把多 agent 协作过程做成时间线讨论流，让用户看到子代理在"发现什么 / 决定什么 / 当前在干什么"。前端侧见 [frontend.md](./frontend.md)。

- `SwarmContextUpdate`（`src/shared/contract/swarm.ts`）：`kind = finding | decision | status | result` + `agentId` / `role` / `content` / `key`（去重）/ `at`（ms epoch，源自 0.0.9 的 `lastUpdated` 版本戳）。
- 发布：`SwarmEventEmitter.contextUpdate()` 发 `swarm:context:update` 事件；子代理 `STATUS:` / `DECISION:` 自报行经 `statusReport.ts` 解析喂入；discovery 事件映射为 finding。
- 渲染：`stores/swarmStore.ts` 的 `buildTimelineEntry()` 映射到 eventLog；`DiscussionStream.tsx` 按 `kind` 给图标、决策高亮、相对时间；`SwarmInlineMonitor.tsx` 嵌入悬浮层，收起态显近 3 条、展开全时间线。

关键文件：`src/host/agent/swarmEventPublisher.ts`、`src/host/agent/multiagentTools/statusReport.ts`、`src/renderer/components/features/swarm/DiscussionStream.tsx`。

## 0.0.11 2026-06-03 角色主动性（role-proactivity，P0-1 下半）

角色从被动工具升为主动协作者：按 cadence 或长任务事件醒来，查自己的产物历史，自主决定 advance/report/suggest/silence。设计见 [role-proactivity.md](../designs/role-proactivity.md)。

| 能力 | 当前口径 | 关键文件 |
|------|----------|---------|
| 双触发入口 | cadence（启动 `syncCadenceJobs()` 注册 per-role cron，幂等 tag `role-cadence`）+ event（长任务 Stop hook，turn≥5 且未超日配额，经 `runFinalizer`） | `src/host/services/roleAssets/roleProactivity.ts`、`src/host/agent/runtime/runFinalizer.ts` |
| 8 步 wakeRole 循环 | 日配额检查 → `instantiateRole` 注入 memory+history → 建 schedule 会话 → 双路执行（Electron orchestrator / headless cli bootstrap）→ 解析 `<decision>advance\|report\|suggest\|silence</decision>` → silence 归档/非 silence 推 `SESSION_LIST_UPDATED` → 写回 history | `src/host/services/roleAssets/roleProactivity.ts` |
| 硬预算 | 每次醒来 15 turn、每角色每天 4 次（cadence + event 合并计数）；醒来会话标 `origin=role-cadence`，Stop hook 跳过此类会话防递归 | `src/shared/constants/memory.ts`（`ROLE_PROACTIVITY`）|
| 配置分层 + 出厂默认 | 角色 frontmatter `proactivity-level` > `settings.roleAssets.proactivity.defaultLevel` > 常量；`RoleProactivityLevel = silent\|daily\|realtime`，**出厂默认 silent（opt-in）**；设置页角色面板露主动等级开关 | `src/shared/contract/roleAssets.ts`、`src/renderer/components/features/settings/tabs/RolesTab.tsx` |

范围自限：只查角色自己参与的产物历史（P0-2 项目空间落地后升项目维度）；不接外部渠道（飞书等），只走 session 消息 + history append + （realtime）Electron Notification。

## 0.0.12 2026-06-11 嵌套子 Agent（context offload）

子 agent 现在可以继续派生子 agent，用于递归调查、跨系统 bug 追踪和大规模重构的上下文卸载。默认深度是 3，硬上限是 5；这不是无界并行能力，整棵 spawn tree 共享同一个并发、超时和预算边界。

| 能力 | 当前口径 | 关键文件 |
|------|----------|----------|
| 深度限制 | 默认允许主→子→孙，配置值会 clamp 到硬上限 5；超限错误包含当前深度与上限，方便模型改路由 | `src/shared/constants/agent.ts`、`src/host/agent/spawnGuard.ts` |
| 工具放行边界 | 子 agent 内只放行 `Task` / `spawn_agent` 等内部 delegation 工具；`workflow`、`ask_user_question`、agent 间自由通信和 plan review 仍禁用 | `spawnGuard.ts`、`src/host/tools/permissionClassifier.ts` |
| 全树配额 | 不再按每层 `MAX_AGENTS` 乘法扩张；根 run 拥有 tree quota，超额请求 FIFO 等待并可超时 | `spawnGuard.ts`、`parallelAgentCoordinator.ts` |
| 超时与 token | 子层超时取角色默认值和父剩余时间的较小值；`parentRemainingBudget` 多层传递，tokens/cost 逐层回灌到根 | `subagentPipeline.ts`、`subagentUsageAccounting.ts` |
| 取消与孤儿 | 用户取消/会话切换向整棵树穿透；中间层超时或失败只清理对应子树；父 run 消失时 DFS 回收后代 | `subagentExecutorCancellation.ts`、`orphanLiveness.ts` |
| 输出蒸馏 | 子 agent 的最终输出面向父 agent 消费，只返回结论、关键路径和必要证据，不转发大量原始文件内容 | `subagentExecutor.ts`、`spawnAgent.schema.ts`、`task.schema.ts` |

验收口径：multi-agent 相关 23 个 test file / 306 tests 通过，`npm run build:web` 通过；浏览器实跑中 root `Task` 派生一层 coder，再由一层 coder 派生二层 coder，最终根会话可见孙 agent 输出。

## 0.1 节点级 Checkpoint（断点恢复）

多 agent DAG 执行中，网络中断或 token 耗尽会导致已完成节点工作白费。
Checkpoint 机制在每个节点成功后持久化结果，重新执行时自动跳过。

### 机制

| 项 | 说明 |
|----|------|
| **存储位置** | `~/.code-agent/coordination-checkpoints/<sessionId>.json` |
| **存储粒度** | Agent 节点级（非工具调用级） |
| **缓存条件** | 仅 `completed` 状态持久化，`failed` 不缓存以支持重试 |
| **恢复条件** | sessionId 相同 + agentIds 列表完全匹配 |
| **清理时机** | 全部 agent 成功后自动删除 checkpoint 文件 |

### 流程

```
execute() 入口
  ├── loadCheckpoint(sessionId, agentIds)
  │   ├── 文件不存在 → createCheckpoint()（新执行）
  │   ├── agentIds 不匹配 → deleteCheckpoint() + createCheckpoint()（执行计划变了）
  │   └── 匹配 → 恢复（跳过已完成节点）
  │
  ├── executeSequential / executeParallel
  │   ├── 每个 agent 执行前：检查 checkpoint.completedNodes[agentId]
  │   │   ├── 命中 → skip + 使用缓存 output 作为 L1 传递
  │   │   └── 未命中 → 正常执行
  │   └── 每个 agent 成功后：saveCheckpoint()
  │
  └── aggregateResults
      └── 全部成功 → deleteCheckpoint()
```

---

> ⚠️ **以下为早期设计稿**（v0.16.55 前），保留作为历史参考。

## 1. 问题诊断

### 1.1 当前系统的问题

1. **图片数据传递错误**
   - `SubagentExecutor` 没有正确处理 data URL 格式的 base64 图片
   - `img.data` 可能包含 `data:image/png;base64,xxx` 前缀，但代码直接使用导致数据错误

2. **上下文传递不完整**
   - 工作流只传递文本输出 (`stageOutputs: Map<string, string>`)
   - 前一阶段的结构化数据（如 OCR 坐标）无法被后续阶段正确解析

3. **Agent 定义系统不完善**
   - 缺少 Plan Agent（规划型）
   - 缺少 Coordinator Agent（协调型）
   - 视觉 Agent 定义不够精确

4. **工作流模板过于简单**
   - 没有条件分支
   - 没有错误恢复机制
   - 没有中间结果验证

## 2. 新架构设计

### 2.1 Agent 类型层次

```
┌─────────────────────────────────────────────────────────────────┐
│                       Agent 类型分层                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Layer 0: Meta Agents (元 Agent)                               │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │   Planner      │  │  Coordinator   │  │   Evaluator    │   │
│  │   规划任务分解  │  │   协调多Agent  │  │   评估结果质量  │   │
│  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                 │
│  Layer 1: Specialist Agents (专家 Agent)                       │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │ Code Reviewer  │  │   Debugger     │  │   Architect    │   │
│  │   代码审查     │  │   调试定位     │  │   架构设计     │   │
│  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                 │
│  Layer 2: Vision Agents (视觉 Agent)                           │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │    Analyzer    │  │   Processor    │  │   Annotator    │   │
│  │  视觉分析理解   │  │   图片处理     │  │   图片标注     │   │
│  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                 │
│  Layer 3: Worker Agents (执行 Agent)                           │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │    Coder       │  │  Test Writer   │  │  Documenter    │   │
│  │    编写代码    │  │   编写测试     │  │   编写文档     │   │
│  └────────────────┘  └────────────────┘  └────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 新 Agent 定义

#### Plan Agent (规划型)
```typescript
{
  id: 'planner',
  name: 'Planner Agent',
  description: '分析复杂任务并制定执行计划，分解为可执行的子任务',
  systemPrompt: `你是任务规划专家。职责：
1. 分析用户任务的复杂度和依赖关系
2. 分解为可独立执行的子任务
3. 确定子任务的执行顺序和并行可能性
4. 为每个子任务匹配合适的专家 Agent

输出格式（JSON）：
{
  "analysis": "任务分析",
  "subtasks": [
    {
      "id": "task-1",
      "description": "子任务描述",
      "agent": "agent-id",
      "inputs": ["依赖的前置任务输出"],
      "priority": 1
    }
  ],
  "executionOrder": [["task-1"], ["task-2", "task-3"]], // 并行组
  "estimatedComplexity": "low|medium|high"
}`,
  tools: ['Read', 'Glob', 'Grep'],  // 只读工具，用于分析
  maxIterations: 5,
  canSpawnSubagents: true,  // 可以建议 spawn 其他 agent
}
```

#### Vision Analyzer Agent (视觉分析)
```typescript
{
  id: 'vision-analyzer',
  name: 'Vision Analyzer',
  description: '使用视觉模型分析图片内容，输出结构化的分析结果',
  systemPrompt: `你是视觉分析专家。职责：
1. 描述图片的整体内容
2. 识别并定位图片中的关键元素
3. 输出结构化的位置信息

**重要：输出格式必须是 JSON**

对于 OCR 任务，输出格式：
{
  "type": "ocr",
  "imageSize": { "width": 1920, "height": 1080 },
  "textRegions": [
    {
      "text": "识别到的文字",
      "boundingBox": {
        "x": 100,      // 左上角 x（像素）
        "y": 50,       // 左上角 y（像素）
        "width": 200,  // 宽度（像素）
        "height": 30   // 高度（像素）
      },
      "confidence": 0.95
    }
  ]
}

对于元素检测任务，输出格式：
{
  "type": "detection",
  "imageSize": { "width": 1920, "height": 1080 },
  "elements": [
    {
      "type": "button|text|image|icon",
      "description": "元素描述",
      "boundingBox": { "x": 100, "y": 50, "width": 80, "height": 30 }
    }
  ]
}`,
  tools: [],  // 纯视觉模型，无工具
  maxIterations: 1,  // 单轮分析
  modelOverride: {
    provider: 'zhipu',
    model: 'glm-4v-flash',
  },
}
```

#### Vision Annotator Agent (视觉标注)
```typescript
{
  id: 'vision-annotator',
  name: 'Vision Annotator',
  description: '根据分析结果在图片上绘制标注',
  systemPrompt: `你是图片标注专家。职责：
1. 解析前一阶段的视觉分析结果（JSON 格式）
2. 调用 image_annotate 工具绘制标注
3. 确保所有需要标注的区域都被正确标记

工作流程：
1. 解析输入的 JSON 分析结果
2. 提取所有 boundingBox 信息
3. 将 boundingBox 转换为 image_annotate 工具所需的格式
4. 调用工具绘制标注

image_annotate 调用示例：
{
  "image_path": "图片路径",
  "query": "在以下位置绘制矩形框",
  "regions": [
    { "type": "rectangle", "x": 100, "y": 50, "width": 200, "height": 30, "label": "文字1" }
  ]
}`,
  tools: ['image_annotate', 'Read', 'Write'],
  maxIterations: 10,
}
```

### 2.3 上下文传递机制

#### StageContext 类型定义
```typescript
interface StageContext {
  // 文本输出
  textOutput: string;

  // 结构化数据（JSON 解析后）
  structuredData?: Record<string, unknown>;

  // 生成的文件
  generatedFiles?: Array<{
    path: string;
    type: 'image' | 'text' | 'data';
  }>;

  // 附件（图片等）
  attachments?: Attachment[];

  // 元数据
  metadata?: {
    duration: number;
    toolsUsed: string[];
    agentId: string;
  };
}

interface WorkflowContext {
  // 原始任务
  task: string;

  // 原始附件（图片、文件）
  originalAttachments: Attachment[];

  // 各阶段输出
  stageOutputs: Map<string, StageContext>;

  // 工作目录
  workingDirectory: string;
}
```

### 2.4 图片数据处理规范

```typescript
/**
 * 规范化图片数据
 *
 * 输入可能是：
 * 1. 纯 base64 字符串
 * 2. data URL (data:image/png;base64,xxx)
 * 3. 文件路径
 *
 * 输出统一为：
 * { base64: string, mimeType: string }
 */
function normalizeImageData(
  data?: string,
  path?: string,
  mimeType?: string
): { base64: string; mimeType: string } | null {
  // 1. 如果有 data 字段
  if (data) {
    // 1.1 检查是否是 data URL
    if (data.startsWith('data:')) {
      const match = data.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return { base64: match[2], mimeType: match[1] };
      }
    }
    // 1.2 假设是纯 base64
    return { base64: data, mimeType: mimeType || 'image/png' };
  }

  // 2. 如果有 path 字段
  if (path && fs.existsSync(path)) {
    const buffer = fs.readFileSync(path);
    const base64 = buffer.toString('base64');
    const detectedMime = mimeType || getMimeTypeFromPath(path);
    return { base64, mimeType: detectedMime };
  }

  return null;
}
```

### 2.5 工作流执行引擎

```typescript
class WorkflowEngine {
  async execute(
    workflow: WorkflowDefinition,
    task: string,
    context: WorkflowContext
  ): Promise<WorkflowResult> {
    const executionGroups = this.buildExecutionGroups(workflow.stages);

    for (const group of executionGroups) {
      // 并行执行同一组内的阶段
      const results = await Promise.all(
        group.map(stage => this.executeStage(stage, context))
      );

      // 验证结果
      for (const result of results) {
        if (!result.success) {
          // 错误恢复策略
          if (workflow.errorStrategy === 'retry') {
            // 重试
          } else if (workflow.errorStrategy === 'skip') {
            // 跳过
          } else {
            // 中止
            return { success: false, error: result.error };
          }
        }

        // 存储阶段输出
        context.stageOutputs.set(result.stageName, {
          textOutput: result.output,
          structuredData: this.parseStructuredOutput(result.output),
          generatedFiles: result.generatedFiles,
          attachments: result.attachments,
          metadata: {
            duration: result.duration,
            toolsUsed: result.toolsUsed,
            agentId: result.agentId,
          },
        });
      }
    }

    return { success: true, context };
  }

  private parseStructuredOutput(output: string): Record<string, unknown> | undefined {
    // 尝试提取 JSON
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e) {
        // 解析失败，返回 undefined
      }
    }

    // 尝试直接解析
    try {
      return JSON.parse(output);
    } catch (e) {
      return undefined;
    }
  }
}
```

## 3. 实现计划

### Phase 1: 修复图片传递 (Critical)
1. 修复 `SubagentExecutor` 中的图片 base64 处理
2. 添加 `normalizeImageData` 工具函数
3. 确保图片在所有环节正确传递

### Phase 2: 增强 Agent 定义
1. 添加 `planner` Agent
2. 重新设计视觉 Agent（analyzer + annotator）
3. 添加 `evaluator` Agent

### Phase 3: 重构工作流引擎
1. 实现 `StageContext` 结构化上下文
2. 添加结构化输出解析
3. 实现错误恢复策略

### Phase 4: 新工作流模板
1. `image-ocr-annotate`: OCR + 矩形标注
2. `image-element-detect`: 元素检测 + 标注
3. `code-review-and-fix`: 代码审查 + 自动修复

## 4. 文件变更清单

| 文件 | 变更类型 | 描述 |
|-----|---------|------|
| `src/host/agent/subagentExecutor.ts` | 修改 | 修复图片 base64 处理 |
| `src/host/agent/agentDefinition.ts` | 修改 | 添加新 Agent 定义 |
| `src/host/tools/multiagent/workflowOrchestrate.ts` | 重构 | 实现结构化上下文传递 |
| `src/host/utils/imageUtils.ts` | 新增 | 图片数据规范化工具 |
| `src/host/agent/workflowEngine.ts` | 新增 | 工作流执行引擎 |

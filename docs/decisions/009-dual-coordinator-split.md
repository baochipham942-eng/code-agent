# ADR-009: AutoAgentCoordinator 与 ParallelAgentCoordinator 分家（非合并）

> 状态: accepted
> 日期: 2026-04-13

## 背景

`parallelAgentCoordinator.ts` 顶部从 Sprint 1 起挂着一行注释：

```ts
// NOTE: Used by spawnAgent.ts for explicit parallel execution.
// Planned for merge into AutoAgentCoordinator (Sprint 2).
```

Codex code review（2026-04-13）扣分原因之一：

> parallelAgentCoordinator.ts:1 还写着"planned for merge into
> AutoAgentCoordinator"，ipc/swarm.ipc.ts:9 也直接 import 业务模块。
> 环没了，但 control-plane 还没完全定型。

这行注释已经挂了一段时间没有落地，本次需要决策——**到底合不合**——
然后要么动手合，要么删注释说清楚为什么不合。

## 调查

核实两个协调器的实际形态后，差异远超"同一功能的两个版本"。

### 调用路径（零交集）

| 协调器 | 调用方 | 入口类型 |
|--------|--------|----------|
| `ParallelAgentCoordinator` | `spawnAgent.ts:554`、`swarm.ipc.ts:177/197` | LLM 显式调用 `spawn_agent` tool、UI 侧 swarm 事件 |
| `AutoAgentCoordinator` | `orchestrator/autoAgentRunner.ts:124` | orchestrator 从需求分析后自动生成 agents |

两者的调用方、入口语义、触发链路完全不相交。

### 输入形态（结构性不同）

| 维度 | ParallelAgentCoordinator | AutoAgentCoordinator |
|------|--------------------------|----------------------|
| 输入类型 | `AgentTask[]` | `DynamicAgentDefinition[]` |
| 典型字段 | `id` / `role` / `task` / `dependsOn` / `tools` / `priority` | `name` / `role` / `systemPrompt` / `canRunParallel` / `tools` |
| 依赖表达 | 显式 DAG（`dependsOn: string[]`）| 扁平分组（`canRunParallel: boolean`）|
| 任务来源 | LLM / 用户显式构造 | `agentRequirementsAnalyzer` 从需求推导 |

### 调度机制（互不覆盖）

**ParallelAgentCoordinator 独有**：
- `TaskDAG` + `DAGScheduler`（真正的依赖图调度器）
- `SharedContext`（L2 共享读写存储：findings / files / decisions / errors）
- `EventEmitter` 事件流（task:start / task:progress / task:complete 等）
- `retryTask(taskId)` 单任务重试

**AutoAgentCoordinator 独有**：
- 节点级 checkpoint 持久化（`~/.code-agent/coordination-checkpoints/<sessionId>.json`）
- sequential/parallel/hybrid 执行策略枚举
- L0-L3 通信层级（Isolated / Result Passing / Shared Context / Live Dialogue）
- `progressAggregator` / `parallelErrorHandler` / `resourceLockManager` 协作
- `previousOutput` 自动注入下游（L1 result passing）

### 合并的实际成本

若要合并为单一协调器：

1. **引 adapter 统一输入形态**：至少一层 `AgentTask ↔ DynamicAgentDefinition` 转换层
2. **调度器统一**：`DAGScheduler` 和 `sequential/parallel` 分组是两套算法，需要重新抽象
3. **能力并集变超集**：合并后单一类必须同时支持 DAG + checkpoint + L0-L3 + SharedContext +
   EventEmitter + progressAggregator + 策略枚举，很难维持 YAGNI
4. **收益近零**：调用方零交集，合并不减少实际的使用面

## 决策

**分家，不合并。** `ParallelAgentCoordinator` 与 `AutoAgentCoordinator`
作为两个永久独立的模块，各自服务不同入口形态的不同任务形态。

- 删除 `parallelAgentCoordinator.ts:1-2` 的误导性注释
- 两个文件顶部补"职责边界"段，明确各自的入口、输入、能力、排斥项
- 本 ADR 作为决策依据

## 选项考虑

### 选项 1：强行合并为 `MultiAgentCoordinator`
- 优点：表面上"一个协调器"概念统一
- 缺点：需要 adapter 层、统一调度器、能力并集超集化；收益近零因为调用方零交集；违反 YAGNI
- 结论：**不选**

### 选项 2：分家，边界文档化（本 ADR 选项）
- 优点：尊重实际结构，零破坏性；两侧可独立演进；消除注释债
- 缺点：新人需要看 ADR-009 才知道为什么有两个
- 结论：**选**

### 选项 3：保留现状（注释挂着）
- 优点：零成本
- 缺点：Codex 指出的"control-plane 未定型"问题持续存在；新人看注释以为合并计划还活着
- 结论：**不选**

## 后果

### 积极影响
- 控制面定型，不再有"待合并"的悬空计划
- 两个协调器可以独立演进，`Parallel` 可以深化 DAG 能力（拓扑排序优化、动态重规划等），
  `Auto` 可以深化 checkpoint 能力（增量快照、失败子树回放等），互不阻塞
- Codex review 提出的扣分项关闭

### 消极影响
- 概念上必须记住"两个协调器按入口分家"，对贡献者有一次性学习成本
- 未来如果出现第三类入口（比如 cron 驱动的定时 agent 调度），需要判断归属或新建第三个协调器

### 风险
- **功能漂移风险**：两个协调器各自独立演进后，某些通用能力（如节点级 checkpoint）可能
  只在 Auto 侧存在；若 Parallel 侧也需要，需要单独补或抽共享工具函数
- **缓解**：跨协调器共享能力（checkpoint、错误处理、资源锁）应抽到独立模块
  （如 `services/coordination/*`），由两个协调器分别引用，而不是由其中一个"拥有"

## 相关文档

- [ADR-008: Swarm Actor/SendMessage 重构](./008-swarm-actor-refactor.md) — 解决了这两个协调器所在层的循环依赖
- [ADR-007: Protocol Migration Reality Check](./007-protocol-migration-reality-check.md) — 架构优化主线
- `src/main/agent/parallelAgentCoordinator.ts`（顶部职责边界）
- `src/main/agent/autoAgentCoordinator.ts`（顶部职责边界）

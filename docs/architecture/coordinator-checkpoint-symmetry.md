# Coordinator Checkpoint 对称性对照

> 配套 ADR-009（两协调器分家）、ADR-010 item #3（parallel checkpoint 对称补齐）

ADR-009 明确两个 coordinator 分家不合并，服务完全不同的入口。ADR-010 #3
要求它们在 **crash-safe** 这条基础能力上对称：都能把节点级进度落到磁盘，
主进程被 kill 后重启可以跳过已完成节点重跑剩余 DAG。

本文档并排列出两个 coordinator 的 checkpoint 字段与触发点，作为 review
阶段"对称性是否真的补齐"的 checklist。

## 入口与职责（简要）

| 维度 | AutoAgentCoordinator | ParallelAgentCoordinator |
|------|----------------------|--------------------------|
| 入口来源 | `orchestrator/autoAgentRunner` 从需求分析生成 | LLM 显式调 `spawn_agent` / `parallel_agent_run`，UI swarm |
| 输入形态 | `DynamicAgentDefinition[]`（含 canRunParallel / role / systemPrompt） | `AgentTask[]`（含 dependsOn / tools / priority 的 DAG 节点） |
| 调度策略 | sequential / parallel / hybrid（按 `ExecutionStrategy`） | 依赖排序 group-by-group 并行，或走 TaskDAG + DAGScheduler |
| 共享通信 | L0 隔离、L1 Result Passing、L2 Shared Context | EventEmitter + SharedContext（findings / files / decisions / errors） |

## Checkpoint 目录

| Coordinator | 常量 | 路径 |
|-------------|------|------|
| Auto | `COORDINATION_CHECKPOINTS.AUTO_DIR` = `coordination-checkpoints` | `~/.code-agent/coordination-checkpoints/<sessionId>.json` |
| Parallel | `COORDINATION_CHECKPOINTS.PARALLEL_DIR` = `parallel-coordination-checkpoints` | `~/.code-agent/parallel-coordination-checkpoints/<sessionId>.json` |
| 共用 | `COORDINATION_CHECKPOINTS.SCHEMA_VERSION` = `1` | 两边的 `version` 字段都用这个常量比对 |

## Schema 字段对照

| 字段 | Auto 字段 | Parallel 字段 | 序列化策略 | 说明 |
|------|-----------|---------------|-----------|------|
| schema 版本 | — | `version: number` | 直接数字 | Auto 目前没写 version，读到陌生字段自行丢弃；Parallel 会对比 `SCHEMA_VERSION` 不匹配就 stale |
| 会话 ID | `sessionId: string` | `sessionId: string` | 直接 JSON | 都从 context 上拿 |
| 任务清单 | `agentIds: string[]`（仅 ID，用来在 load 时校验计划一致） | `taskDefinitions: Array<[string, AgentTask]>`（完整 Map entries） | Map → entries | Parallel 持久化完整定义，因为 `retryTask` / 重启后 UI 需要还原 task 详情；Auto 定义由 autoAgentRunner 重新生成，只校验 ID 顺序是否一致 |
| 完成节点 | `completedNodes: Record<string, AgentExecutionResult>`（只写 status === 'completed'） | `completedTasks: Array<[string, AgentTaskResult]>`（成功与失败都写） | Map → entries | Auto 只缓存成功节点，失败节点下次 execute 时会重跑；Parallel 同样只对成功节点短路，但失败记录也保留到快照便于审计 |
| 运行中节点 | 不持久化 | `runningTaskIds: string[]`（只记 ID，Promise 丢弃） | 数组 | Parallel 记录崩溃瞬间还在跑的任务 ID；重启后不进 completedTasks，由下一轮 executeParallel 重新调度 |
| 共享上下文 | 不持久化 | `sharedContext: { findings, files, decisions, errors }` | Map → Record + 数组 | Parallel 的 SharedContext 是 L2 通信基石，需要重建；Auto 的 sharedContext 只在单次 run 内有意义，不跨重启 |
| 时间戳 | `createdAt: number` / `updatedAt: number` | `createdAt: number` / `updatedAt: number` | `Date.now()` | 对称 |
| AbortController | 不持久化 | 不持久化 | — | 运行时对象，重启后新建 |

## 落盘触发点

| 触发点 | Auto | Parallel |
|--------|------|----------|
| 顺序 / 并行 / DAG 中节点完成（成功） | `executeSequential` / `executeParallel` 内 `completedNodes[id] = result` 后 `saveCheckpoint` | `executeTask` 末尾 `schedulePersist` |
| 节点完成（失败） | 不写（失败节点下次重跑） | `executeTask` catch 分支也 `schedulePersist`，失败记录入快照 |
| executeParallel 收尾 | 成功后 `deleteCheckpoint`，失败无操作 | 成功后 `deleteCheckpointIfPresent`（会先 drain 再 delete）；失败 `drainPersist` 确保快照落盘 |
| executeWithDAG 收尾 | — | `convertSchedulerResult` 后 `drainPersist` |
| 写盘机制 | 同步 `fs.writeFileSync` | 异步 `fs.promises.writeFile`，`pendingPersist` 串行链避免 save/delete 竞争 |

## Restore 语义

| 方面 | Auto | Parallel |
|------|------|----------|
| 入口 API | 隐式（每次 `execute()` 首行 `loadCheckpoint`） | 显式 `restoreCheckpoint(sessionId)`，在 `initialize` 之后、`executeParallel` 之前由外部调用 |
| 计划一致性校验 | `agentIds` 完全相等才承认，否则 stale 并删除 | schema `version` 匹配即承认；后续 executeParallel 传入的 tasks 如果 ID 不同会 overwrite taskDefinitions（cache-skip 只看 completedTasks） |
| 崩溃时运行中节点 | 不感知 | `runningTaskIds` 保留在快照里供审计；重启后这些任务不在 `completedTasks`，被下一轮 executeParallel 自然重新调度 |
| 失败节点重跑 | 不写入缓存，天然重跑 | cache-skip guard 只短路 `success === true`，失败节点会重跑 |
| sharedContext | N/A | `importSharedContext` 复原 findings / files / decisions / errors |

## 已知不对称点

1. **DAG 路径的 restore 不闭环**：Parallel 的 `executeWithDAG` 把调度交给外部
   `DAGScheduler`，scheduler 内部不感知 `completedTasks`。我们只在
   `convertSchedulerResult` 末尾做一次批量 save，但重启后再次调
   `executeWithDAG` 会把 DAG 重头跑一遍（scheduler 自己的状态机没有喂入
   checkpoint）。DAG 路径的 crash-safe 是**增量记录**语义，不是**增量恢复**。
   这条进一步闭环需要改 DAGScheduler，超出 ADR-010 #3 的机械化对齐范围。

2. **Auto 没有 schema version 字段**：Auto 的 checkpoint JSON 没写 `version`，
   读取时只靠 `agentIds` 校验。Parallel 新引入的 `SCHEMA_VERSION = 1` 只约束
   自己的 Parallel 快照。如果未来要给 Auto 加版本号，应走 ADR-010 的后续条目，
   本 ADR 刻意不碰 Auto 代码。

3. **fs 同步 vs 异步**：Auto 用 `writeFileSync`，Parallel 用
   `fs.promises.writeFile` + pendingPersist 链。异步路径配合串行链可以做到
   fire-and-forget 不阻塞主流程，又能在收尾 drain。Auto 的同步写法在顺序场景
   也够用，但如果未来想让 Auto 也非阻塞写盘，可以照 Parallel 这一套挪过去。

## 测试证据

- `tests/unit/agent/parallelAgentCoordinatorCheckpoint.test.ts` — 13 用例覆盖
  persist / restore / 版本与损坏处理 / 恢复后 executeParallel 短路 /
  成功清理 + 失败保留
- `tests/unit/agent/parallelAgentCoordinator.test.ts` — 19 用例的既有行为回归，
  `retryTask` 已加 `completedTasks.delete` 绕过 cache-skip 保留重试语义
- `npm run test:swarm:smoke` — 30 用例集成/渲染层全绿，无回归

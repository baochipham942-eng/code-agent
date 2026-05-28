# ADR-018: 下线 MasterTask（跨 session 任务看板）

> 状态: accepted
> 日期: 2026-05-28

## 背景

MasterTask 是早期实验性的跨 session 任务看板能力，由 `masterTaskManager` + `MasterTaskRepository` + 前端 `TaskBoardPanel` / `TaskDetailPanel` / `MasterTaskCounter` 组成，目标是把同一个"母任务"在不同 session 之间贯穿、提供全局任务视图。

实际使用中暴露的问题：

- 模型在 multi-agent / swarm 场景已经有 plan、TaskList、tool-call 链作为任务粒度载体，跨 session 任务面板与这些机制语义重叠。
- TaskBoard 维护成本高（state machine + IPC + repository），但产品价值未被验证。
- `/goal` 模式（ADR 未编号，docs/designs/goal-mode.md）走的是单 agent 闭环路径，与 MasterTask 不耦合。
- "聊天主链路即工作台"的方向（[ADR-011](011-chat-native-workbench.md)）让 sidecar 任务面板的位置变得尴尬。

## 决策

下线 MasterTask 功能。**仅删代码，不动 DB schema**（保留 `master_tasks` / `master_task_plan_events` 表 + `sessions.master_task_id` 列，避免迁移风险）。

具体删除范围（commit `841200af`）：

- 后端：`masterTaskManager` / `masterTask` / `masterTask.ipc` / `ensureMasterTaskForSession` / `masterTaskRepository`、`agentOrchestrator` / `subagentExecutor` 调用点、`handlers` / `legacy-channels` / `SessionRepository` 委托
- 前端：`TaskBoardPanel` / `TaskDetailPanel` / `MasterTaskCounter` / `masterTaskStore`、`App.tsx` / `WorkbenchTabs.tsx` / `appStore.ts` 引用
- 共享：`src/shared/contract/task.ts`、`shared/ipc/handlers.ts` / `legacy-channels.ts` 相关条目

共删除 22 个文件、净减少约 2800 行。

## 选项考虑

### 选项 1: 完全删除（含 DB 迁移）
- 优点: 彻底干净
- 缺点: DB 迁移风险（存量数据/外键），收益有限

### 选项 2: 仅删代码、保留 DB schema（已采用）
- 优点: 零迁移风险；如未来重启需要可低成本恢复 schema 层
- 缺点: DB 残留两张未使用的表

### 选项 3: 改造为 swarm 内部 plan 载体
- 优点: 复用现有数据结构
- 缺点: 语义错配（MasterTask 是跨 session、swarm plan 是单 run 内），改造成本大于重写

## 后果

### 积极影响
- 减少 2800 行代码，降低维护面
- `/goal` 模式的产品边界更清晰（单 agent 闭环，不与跨 session 看板争语义）
- WorkbenchTabs / appStore 复杂度下降

### 消极影响
- 已使用 MasterTask 的本地用户（如有）丢失该面板入口；旧 session 记录的 `master_task_id` 不再有 UI 暴露面
- DB 残留两张未使用的表（可在后续迁移中清理）

### 风险
- 如未来产品方向重新需要"跨 session 任务编排"，需要重新设计（建议复用 swarm trace + plan 数据，不要恢复独立 MasterTask 子系统）

## 相关文档

- [ADR-011: Chat-Native Workbench](011-chat-native-workbench.md)
- [docs/designs/goal-mode.md](../designs/goal-mode.md) — P4 swarm goal 标注已更新
- commit `841200af` — 实施 commit

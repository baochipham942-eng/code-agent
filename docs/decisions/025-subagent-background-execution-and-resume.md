# ADR-025: Subagent 后台执行 + agent_id resume 跨重启（Kimi 借鉴 #2）

- **状态**: 已采纳 — **A1 + B1 + C1**（2026-06-19 拍板：后台执行 only，跨重启 resume(A2) 降级为二期按需评估）
- **日期**: 2026-06-19
- **关联**: ADR-022/023/024（append-only 事件账本）；Kimi 竞品借鉴清单 #2

## 背景

Kimi AgentSwarm 支持 `run_in_background=true` 后台跑子 agent + 凭 `agent_id`
**resume 跨重启**保留完整上下文续跑——无人值守长任务的实在能力。Neo 现状
（grep 复核）：

- 子 agent **只能同步阻塞**跑完（`spawnAgent` tool `await executeSubagent`）。
- agent_id 是**一次性临时**的（`subagentExecutor.ts:126` = `agent-${Date.now()}-${random}`），重启即丢。
- `SubagentContextStore` 落盘了隔离上下文（`~/.code-agent/subagent-context-store.json`），但 **TTL 仅 2h**、不存执行进度。
- `backgroundTask` 框架（`shared/contract/backgroundTask.ts` + repository）已存在但**未接 subagent**。
- `parallelAgentCoordinator` 有 task 级 checkpoint，但**不是 subagent 级**。

即"后台句柄 + resume 续跑接口"真缺，地基部分具备。

## 待拍板的决策

### D1 — 范围：做全套跨重启 resume，还是先做"后台执行不 resume"？

| 选项 | 内容 | 成本 | 风险 |
|------|------|------|------|
| **A1（推荐先做）** | **后台执行 only**：子 agent 可 `run_in_background`，返回稳定 agent_id，前台不阻塞；进程内可查状态/取结果。**不**跨重启 resume | 中 | 低（不动 DB schema 大改，复用 backgroundTask） |
| A2 | 全套：后台执行 + 跨重启 resume（新建 subagent 执行日志表，重启后凭 agent_id 从断点续跑） | 高 | 高（DB schema + 执行核心 + 与 codex lane schema.ts 撞车） |

> 建议 **A1 先落**（拿到 80% 价值：无人值守后台跑），A2 跨重启 resume 作为
> 二期单独评估——因为真正"重启后续跑"要持久化每轮 LLM 推理/工具状态，是
> ADR-022 账本级的工程量，且当前没有强用户信号要求"关了 app 还能续子 agent"。

### D2 — 稳定 agent_id 方案

- **B1（推荐）**：持久化随机 id（spawn 时生成 UUID-like，落 backgroundTask 记录），跨调用稳定、可查。
- B2：`${sessionId}:${counter}` 确定性 id。

> 建议 B1：与 backgroundTask 现有 id 体系一致，最小改动。

### D3 — 后台机制

- **C1（推荐）**：复用现有 `backgroundTask` 框架——`spawnAgent` 增加
  `run_in_background` 入参，true 时把子 agent 跑进 backgroundTask（返回 task_id/agent_id 不阻塞），状态/结果走 backgroundTaskRepository。
- C2：新建 subagent 专用后台机制。

> 建议 C1：don't reinvent，backgroundTask 的 queued/running/completed 状态机现成。

### D4 — 与 codex lane 的 schema 撞车（仅 A2 涉及）

`codex/session-automation-closure` 已改 `database/schema.ts`（+27 行加表）。
若选 A2（需加 subagent 执行日志表），两条 lane 落 main 时 schema.ts 会冲突 +
迁移顺序要协调。**A1 不加表 → 无此冲突**（又一条选 A1 的理由）。

## 推荐组合

**A1 + B1 + C1**：后台执行 + 稳定 id + 复用 backgroundTask，不碰 DB schema、
不与 codex lane 撞车、拿到无人值守主价值。跨重启 resume（A2）降级为二期、按
真实需求再评估。

## 分期（若拍 A1）

1. `spawnAgent` 加 `run_in_background` 入参（默认 false，向后兼容）。
2. 后台路径：子 agent 跑进 backgroundTask，返回稳定 agent_id 不阻塞。
3. 查询/取结果接口：凭 agent_id 查状态、拿最终输出。
4. 进程内 resume（同一 app 生命周期内续看/续等），**非**跨重启。
5. TDD + 影子起步（后台路径默认关，opt-in）+ 不动现有同步 spawn 主路径。

## 后果

- 正面：无人值守长任务能力补齐；复用 backgroundTask 低风险；不动 schema 避开 codex 撞车。
- 负面：A1 不含"关 app 再开还能续子 agent"——若后续有强需求需再走 A2（账本级工程量）。

# Swarm Trace 持久化对照

> 配套 ADR-010 item #5（Swarm Trace 持久化）

ADR-010 #5 要求把每次 swarm 执行的运行/agent/事件三层数据落到 SQLite，
让用户能回溯"上次那个 swarm 为什么失败"。本文档列出三表 schema、写入
触发点、与既有 `agent-history.json` 的关系，以及 review 阶段的对照
checklist。

## 数据模型对齐

三表 schema 直接对齐 Langfuse / OpenTelemetry 的 trace 模型：

| 我们的表 | Langfuse 概念 | OTel 概念 |
|----------|---------------|-----------|
| `swarm_runs` | Trace（容器） | Trace |
| `swarm_run_agents` | Observation 的 rollup | Span |
| `swarm_run_events` | Event（point-in-time） | Span Event |

correlation id（`runId`）写进 `SwarmEvent` 契约本身，对齐 W3C Trace
Context 把 trace id 作为 message header 一等公民的实践。`runId` 由
`SwarmEventEmitter.started()` 用 `crypto.randomUUID()` 生成，所有事件
统一打戳，`completed()` / `cancelled()` 在事件 publish 之后清空。

## 表结构

### swarm_runs（一行 / swarm 执行）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | runId（UUID） |
| `session_id` | TEXT | 关联 sessions.id（可空，未挂会话的 swarm 也允许） |
| `coordinator` | TEXT | `hybrid` / `parallel` / `auto` / `unknown` |
| `status` | TEXT | `running` / `completed` / `failed` / `cancelled` |
| `started_at` | INTEGER | run 起始时间戳 |
| `ended_at` | INTEGER NULL | run 收尾时间戳 |
| `total_agents` | INTEGER | 计划 agent 数量 |
| `completed_count` | INTEGER | 收尾时聚合 |
| `failed_count` | INTEGER | 收尾时聚合 |
| `parallel_peak` | INTEGER | running 并发峰值 |
| `total_tokens_in` | INTEGER | 所有 agent tokens 之和 |
| `total_tokens_out` | INTEGER | 同上 |
| `total_tool_calls` | INTEGER | 同上 |
| `total_cost_usd` | REAL | 同上 |
| `trigger` | TEXT | `llm-spawn` / `ui-launch` / `auto` / `unknown` |
| `error_summary` | TEXT NULL | 失败 agent 错误聚合（≤1024 字符） |
| `aggregation_json` | TEXT NULL | `SwarmAggregation` 快照（含 summary / files / speedup / successRate） |
| `tags_json` | TEXT | 预留 JSON 数组，v1 不强制使用 |

索引：`started_at DESC` / `session_id` / `status`。

### swarm_run_agents（每 agent 一行 rollup）

| 字段 | 类型 | 说明 |
|------|------|------|
| `(run_id, agent_id)` | PK | 复合主键，FK → swarm_runs ON DELETE CASCADE |
| `name` / `role` | TEXT | 显示名 / 角色 |
| `status` | TEXT | `pending` / `ready` / `running` / `completed` / `failed` / `cancelled` |
| `start_time` / `end_time` / `duration_ms` | INTEGER NULL | 执行时间 |
| `tokens_in` / `tokens_out` / `tool_calls` / `cost_usd` | INTEGER / REAL | 累计 |
| `error` | TEXT NULL | agent 失败时的原始错误 |
| `failure_category` | TEXT NULL | 启发式 enum：`timeout` / `cancelled` / `permission` / `rate_limit` / `network` / `parse_error` / `unknown`。**不跑 LLM**，对齐 `telemetry_tool_calls.error_category` 的字符串风格 |
| `files_changed_json` | TEXT | JSON 数组 |

索引：`run_id`。

### swarm_run_events（run timeline）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER PK AUTOINCREMENT | 内部自增 |
| `run_id` | TEXT | FK → swarm_runs ON DELETE CASCADE |
| `seq` | INTEGER | 单调递增（writer 自维护） |
| `timestamp` | INTEGER | 事件发生时间 |
| `event_type` | TEXT | 原 SwarmEvent.type，例如 `swarm:agent:completed` |
| `agent_id` | TEXT NULL | 事件归属的 agent |
| `level` | TEXT | `debug` / `info` / `warn` / `error`（对齐 Langfuse log level） |
| `title` / `summary` | TEXT | 渲染用文案 |
| `payload_json` | TEXT NULL | 精简后的 SwarmEvent.data，超过 `MAX_EVENT_PAYLOAD_BYTES` 截断 |

索引：`(run_id, seq)`。

## 常量

集中在 `src/shared/constants/storage.ts` 的 `SWARM_TRACE`：

| 常量 | 值 | 含义 |
|------|------|------|
| `DEFAULT_LIST_LIMIT` | 50 | listRuns 默认返回上限 |
| `MAX_LIST_LIMIT` | 200 | listRuns 上限 clamp |
| `MAX_EVENTS_PER_RUN` | 2000 | 单 run 事件数硬上限，超过的尾部事件被丢弃保住 head |
| `MAX_EVENT_PAYLOAD_BYTES` | 8192 | 单条事件 payload_json 字节上限，超出则截断为 `{ _truncated, preview }` |
| `STORAGE_DIR` | `'swarm-runs'` | FileSwarmTraceRepository 的 jsonl 存放子目录（相对 `getUserConfigDir()`） |
| `STORAGE_MODE_ENV` | `'CODE_AGENT_SWARM_STORAGE'` | 后端选择 env：`'file'` 走 JSONL，其他/缺省走 SQLite |

## 双后端：SQLite vs JSONL（2026-05-28，Pi 借鉴）

为支持 CLI / headless / Web Server 场景（无 better-sqlite3 可用、或不想污染主 DB），新增 JSONL 文件后端，与 SQLite 后端**实现同一个 `SwarmTraceRepo` 接口**，由 factory 按 env 路由：

| 后端 | 选择条件 | 文件 |
|------|----------|------|
| `SwarmTraceRepository` (SQLite) | env 缺省或 `CODE_AGENT_SWARM_STORAGE` 非 `'file'` | `src/main/services/core/repositories/SwarmTraceRepository.ts` |
| `FileSwarmTraceRepository` (JSONL) | `CODE_AGENT_SWARM_STORAGE=file` | `src/main/services/core/repositories/FileSwarmTraceRepository.ts` |
| Factory | 按 env 路由 + 支持 `storageDirOverride` 测试隔离 | `src/main/services/core/repositories/swarmTraceFactory.ts` |

**JSONL 文件布局**：
```
<storageDir>/<YYYY-MM-DDTHHmmss>__<runId>.jsonl
```

每个 run 一个文件，行类型 union：

```
{ "type": "run_started",    ...SwarmRunRecord 初始字段 }
{ "type": "agent_upserted", ...SwarmRunAgent 完整字段 }
{ "type": "event",          ...SwarmRunEvent 字段（payload 受 MAX_EVENT_PAYLOAD_BYTES clamp） }
{ "type": "run_closed",     status, ended_at, totals, aggregation_json }
```

**读取策略**：逐行 `JSON.parse` + 内存回放还原 `SwarmRunRecord` / `agents[]` / `events[]`。`listRuns` 走目录扫描（无单独 index 文件，与 Pi 一致），`getRunDetail` 按 runId 定位文件再回放。

**并发假设**：外层 `SwarmTraceWriter` 已经用 `pendingPersist` Promise 链串行化 + 单 in-process active run 假设 → repo 内部**不加锁、不开异步**。

**CLI / desktop / web server 接线**（commit `bfe2b763`）：

| 入口 | 实际做法 |
|------|----------|
| `src/cli/bootstrap.ts` | 未提供 SQLite DB 时**直接** `new FileSwarmTraceRepository(storageDir)`（不走 factory，硬编码 JSONL），通过 `installCLISwarmTraceWriterIfNeeded()` 把 writer 装进事件链 |
| `src/main/services/core/databaseService.ts` | **唯一调用 `createSwarmTraceRepo` 的地方**（line 192），按 env 路由 SQLite vs JSONL |
| `src/main/index.ts` / `src/web/webServer.ts` | 通过 `db.getSwarmTraceRepo()` 间接拿到 factory 产物，不直接调 factory |
| `src/cli/adapter.ts` / `src/cli/commands/run.ts` | 不直接持有 swarm trace repo —— CLI 路径的 trace 接线全部在 bootstrap.ts |

> ⚠️ bootstrap.ts 没走 factory 是已知不一致。新增第三种后端（如 cloud）时需要把 bootstrap.ts 一并切到 `createSwarmTraceRepo(...)`，否则 CLI 会继续硬编码 JSONL。

**Codex 自检留下的边角修复**：
- `be6be2cb` — legacy ctx emit 契约对齐 `AgentEvent` nested 形状（修一个 flat-spread bug pattern）
- `b50b2c73` — Round 3 dogfood log + `npm run test:swarm:smoke` smoke script

## 写入路径

`SwarmEventEmitter` → `EventBus 'swarm' domain` → `SwarmTraceWriter`
→ `SwarmTraceRepo`（由 factory 决定 SQLite 或 JSONL；两个实现都同步落地，JSONL 走 `fs.appendFileSync`）。

写入策略：
- `SwarmTraceWriter.schedulePersist()` 用 `Promise` 串行链 fire-and-forget
  入队，事件发布者不被阻塞
- 每条写入失败只 warn，不抛
- run 收尾后调 `drain()` 等待最后一笔落盘（测试 / 关停场景使用）

| 触发点 | 表 | repo 方法 |
|--------|-----|-----------|
| `swarm:started` | `swarm_runs` | `startRun`（INSERT OR REPLACE，重复同 id 视为新 run） |
| `swarm:agent:added` / `updated` / `completed` / `failed` | `swarm_run_agents` | `upsertAgent`（ON CONFLICT(run_id, agent_id) UPDATE） |
| 任意事件 | `swarm_run_events` | `appendEvent`（受 MAX_EVENTS_PER_RUN 限制） |
| `swarm:completed` | `swarm_runs` | `closeRun`（status / ended_at / 聚合 totals / aggregation_json） |
| `swarm:cancelled` | `swarm_runs` | `closeRun`（status='cancelled' / errorSummary='cancelled'） |

## 与既有 `agent-history.json` 的关系

旧路径：renderer swarmStore 在 agent 完成时通过 `swarm:persist-agent-run`
IPC 把 `CompletedAgentRun` 写进 `~/.code-agent/agent-history.json`
（每 session 最多 10 条）。

新策略（ADR-010 #5 决策）：
- **renderer 停止调用 `swarm:persist-agent-run`**（`persistRunViaIPC`
  保留为 no-op 函数，方便后续完全删除时引用搜索零成本）
- main 侧的 IPC handler 与 `getRecentAgentHistory` 读路径**保留**，让
  历史 JSON 数据仍可被 `swarm:get-agent-history` 读出（兼容老用户数据）
- 新 SQLite 路径覆盖更广（agent rollup + 完整 timeline + 收尾聚合），
  通过新增的 `swarm:list-trace-runs` / `swarm:get-trace-run-detail` IPC
  暴露给 renderer

不做 dual-write：两边 schema 不等价，dual-write 不带来一致性收益。

## Renderer 入口

| 文件 | 角色 |
|------|------|
| `src/renderer/components/features/swarm/SwarmTraceHistory.tsx` | list + detail 两层视图 |
| `src/renderer/components/TaskPanel/Orchestration.tsx` | empty / active 两种状态都挂载历史面板 |

最小可用版（对齐 LangSmith / Langfuse trace viewer v1）：
- list：按 `started_at DESC` 拉 N 条，每行 status / agents / duration /
  cost / tokens
- detail：summary 卡片 + aggregation 摘要 + per-agent rollup 表 +
  timeline 列表

不做（明确出 v1 范围）：
- 跨 run 全文搜索
- run 之间对比
- LLM 自动失败归因
- 长时段聚合统计图表

这些是后续 ADR 条目的范围。

## 测试证据

- `tests/unit/services/SwarmTraceRepository.test.ts` — 13 用例覆盖
  startRun/closeRun lifecycle、upsertAgent ON CONFLICT、appendEvent 上限
  与 payload 截断、listRuns 排序与 clamp、级联删除
- `tests/unit/agent/swarmTraceWriter.test.ts` — 6 用例覆盖 emitter 打戳、
  agent lifecycle rollup、failed 归因、cancelled 清空、双 run 隔离、
  list 排序
- `npm run test:swarm:smoke` — 既有 30 用例无回归
- `tests/unit/agent/swarmServices.test.ts` — 10 用例，stub 已补
  `swarmTraceRepo: null`

UI 视觉验证：暂未做自动截图。组件需要真实 swarm run 数据才能渲染有意义
内容，需要在用户本地 `cargo tauri dev` 后人工跑一次 swarm 触发数据，
打开 TaskPanel 的编排 tab 复核 list / detail 两个视图。

## 已知不对称点 / 后续工作

1. **runId 只在 SwarmEventEmitter 一侧生成**：`ParallelAgentCoordinator`
   走自己的 node EventEmitter，没接 SwarmEventEmitter 的事件流。当前
   trace 只覆盖 `agentSwarm.execute()` 入口（hybrid coordinator）；
   如果未来 ParallelAgentCoordinator 也想被 trace，需要让它通过
   SwarmEventEmitter 转发 lifecycle 事件。
2. **trigger 字段默认 `unknown`**：v1 没接 `ui-launch` / `llm-spawn` 的
   分类入口。future：在 `swarm.ipc.ts` 的 launch handler 或 spawn 入口
   通过 emitter 提供的 hook 标记。
3. **没有保留期清理**：`swarm_runs` 现在无限累积。后续可加 cron 删除
   N 天前的 run，或在 IPC handler 中加分页。本 ADR 范围之外。
4. **renderer 暂无组件单测**：项目没有 react-testing-library 设施，
   组件验证靠 typecheck + 集成测 + 人工。引入 jsdom 是后续基建条目。

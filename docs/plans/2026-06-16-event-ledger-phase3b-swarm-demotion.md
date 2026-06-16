# 事件账本 第三期(3b) · Swarm 旧表降级（实施计划）

> 日期: 2026-06-16 · 作者: Neo · 状态: 已完成（6 步全绿 + 对抗审查闭环，证据见 evidence/2026-06-16-ledger-phase3b-swarm-demotion.md）
> 上游决策: [ADR-023](../decisions/023-event-spine-read-projection-and-swarm-demotion.md) 决策点 2 = **D2 双写过渡**（并行追加→影子对账→切换降级），已 accepted
> 分支: `feat/event-ledger-phase3b`（基于最新 main，含 3a）
> 前提: 用户不读代码、不做 review。质量由每步可执行验证闸门保证。**无新增 ADR**（D2 方向已拍板）。

## 1. 目标与边界

**目标**：兑现 ADR-022/023 的"**让 append-only 事件流当 Swarm 协同轨迹的真理源，把可变 rollup 表（`swarm_runs`/`swarm_run_agents`）降级为可从事件流重建的读优化缓存**"。交付证据：① 一条新 append-only 协同事件流并行落库；② 影子对账证明"从事件流重建出的 rollup == 现存 rollup 表"（逐字段）；③ 一本账/详情读出可由事件流投影当真理源，rollup 退为回退缓存。

**为什么不能直接用现有的流**（调研结论）：
- SQLite `swarm_run_events`：append 但**超 2000 条丢尾**（`SWARM_TRACE.MAX_EVENTS_PER_RUN`）+ payload 8KB 截断 → 长 run 会丢 rollup 关键事件，**不够格当真理源**。
- JSONL `FileSwarmTraceRepository`：是完整 append-only 流，但**仅 `CODE_AGENT_SWARM_STORAGE=file` 非默认模式**启用，默认 SQLite 模式下不写它。
- 结论：**新建一张专用 append-only 表 `swarm_run_ledger`**（承接 phase1/2/3a 的"按场景各一张只追加小表"惯用法），记录 rollup 关键生命周期事件（`run_started`/`agent_snapshot`/`run_closed`），**不丢尾、不截断关键字段**，与存储模式无关。

**D2 三步在本分支的落地**（每步可停可回滚）：
- **步骤①并行追加**：`SwarmTraceWriter` 在现有 rollup 写入**旁**，fail-safe fire-and-forget 追加一条 `swarm_run_ledger` 事件。**不改任何现有写入**（startRun/upsertAgent/closeRun 原样保留）。
- **步骤②影子对账**：`SwarmRollupProjection` 纯函数从 ledger 重建 run+agents rollup；reconciliation 逐字段比对"重建值 vs 现存表值"，产出 drift 报告，经诊断出口暴露。纯只读。
- **步骤③切换降级**：`getRunDetail`/`readSwarmRunsForSession`（3a 一本账协同 lane）**优先**用 ledger 投影（真理源），ledger 无该 run 时**回退** rollup 表（缓存/兼容历史 run）。**写路径不动**——rollup 继续被写，但身份从"真理源"降为"读缓存/回退"。

**纯增量 + 可回退边界（明确不做）**：
- **不删除、不改写** startRun/upsertAgent/closeRun 的现有写入逻辑（rollup 表照常写，作缓存）。
- 不动 `swarm_run_events`（保留其 timeline 用途）、不动 JSONL repo、不动 SwarmTraceRepo 接口的写方法签名。
- ledger 追加全程 fail-safe（吞错 + fire-and-forget），**绝不影响 swarm 运行 / 现有持久化**。
- 切换降级带**回退兜底**（ledger 缺失走 rollup），不制造"老 run 读不出"。
- 不做后台定时对账自动化（第四期）；本期对账是"按 run 结束触发 + 诊断出口手查"。

## 2. 现状锚点（file:line）

```
Swarm 持久化唯一入口:   src/main/agent/swarmTraceWriter.ts:70/109-138/401-409   pendingPersist 串行链 + 事件分发 + schedulePersist
  startRun:            swarmTraceWriter.ts:166-176        swarm:started
  upsertAgent:         swarmTraceWriter.ts:194-215        swarm:agent:*（ON CONFLICT 覆盖）
  appendEvent:         swarmTraceWriter.ts:286-298        所有 swarm:*（超 2000 丢尾）
  closeRun:            swarmTraceWriter.ts:223-241        swarm:completed/cancelled（UPDATE 统计）
  内存 rollup:          swarmTraceWriter.ts:184/301-359    RunState + mergeAgentRollup + aggregateAgentTotals
  parallelPeak:        swarmTraceWriter.ts:186-191/231     运行时数 running agent + Math.max(事件统计)
事件源:                src/main/agent/swarmEventPublisher.ts:80-190               SwarmEventEmitter（每事件打戳 runId）
安装/注入:             src/main/index.ts:197-217          registerSwarmServices + installSwarmTraceWriter
rollup 表:             schema.ts:784-829                  swarm_runs / swarm_run_agents（可变）
现有事件流(有损):       schema.ts:831-846                  swarm_run_events（append+2000上限+8KB截断）
JSONL 完整流(非默认):   repositories/FileSwarmTraceRepository.ts:52-107/578-624    entry 类型 + replayFile 重建
存储模式选择:           repositories/swarmTraceFactory.ts:30-45                    env CODE_AGENT_SWARM_STORAGE
消费读方法:            ipc/swarm.ipc.ts:374-395           listRuns / getRunDetail（UI 唯一入口）
3a 协同 lane 读:        databaseService.ts:384-430         readSwarmRunsForSession + readSwarmEventsForRuns + getSessionLedger
DB facade 先例:        databaseService.ts:256-352         appendPermissionDecision / getSessionLedger（fail-safe 模式）
append 仓储先例:        repositories/PermissionDecisionRepository.ts / ToolExecutionEventRepository.ts
contract:             shared/contract/swarmTrace.ts:68-177  SwarmRunListItem/SwarmRunDetail/SwarmRunEventRecord
测试基线:              tests/unit/agent/swarmTraceWriter.test.ts                  真实 in-memory SQLite
                      tests/unit/repositories/FileSwarmTraceRepository.test.ts / swarmTraceFactory.test.ts
```

## 3. 分步实现（每步先写失败测试后实现，独立 commit）

### 步骤 0 — 基线
`npm run typecheck` + 跑 `swarmTraceWriter.test.ts` / `FileSwarmTraceRepository.test.ts` / `sessionLedger.integration.test.ts` 留绿底。

### 步骤 1 — 新表 + append-only 仓储（协同事件真理源）
- `schema.ts`：新增 `swarm_run_ledger`（id 自增、run_id、session_id 可空、seq、event_kind（`run_started`|`agent_snapshot`|`run_closed`）、agent_id 可空、payload_json、recorded_at）+ 按 (run_id, seq)、(session_id, recorded_at) 建索引。幂等 `CREATE TABLE IF NOT EXISTS`。**无 MAX 上限**（rollup 关键事件不丢）。
- 新增 `repositories/SwarmLedgerRepository.ts`：`append(input, recordedAt?)`（仅 INSERT，时间戳走参数）+ `getByRun(runId)` + `listRunIds(sessionId?, limit?)` + `count()`。**只 INSERT/SELECT，无 UPDATE/DELETE**。
- `shared/contract/swarmLedger.ts`：`SwarmLedgerEventKind` + `SwarmLedgerEvent`（归一化形状，payload 用既有 agent/run 快照字段）。
- **验证**：typecheck；`swarmLedgerRepository.test.ts`（in-memory）：append→getByRun 取回（payload round-trip）；append-only（无 update/delete）；按 run 聚合顺序（seq 升序）；count 递增；多 run 隔离。

### 步骤 2 — SwarmTraceWriter 并行追加（fail-safe，不动现有写入）
- `databaseService.ts`：实例化 `swarmLedgerRepo` + 暴露 fail-safe `appendSwarmLedgerEvent(input)`（照 `appendPermissionDecision`）+ `getSwarmLedgerByRun(runId)` / `listSwarmLedgerRunIds(...)`。
- `swarmTraceWriter.ts`：在 `startRun`/`upsertAgent`(末值快照)/`closeRun` 的 persist 处，**额外** fail-safe fire-and-forget 追加一条 ledger 事件（带 run/agent 快照 + 单调 seq）。**现有 repo 写入一行不改**。
- **验证**：typecheck；`swarmTraceWriter.test.ts` 回归全绿（现有 rollup 写入路径不变）；新增断言：跑一个完整 swarm 生命周期后，ledger 里有 run_started + 各 agent_snapshot + run_closed 成套；DB/ledger 不可用时 swarm 持久化与运行不受影响（不抛）。

### 步骤 3 — SwarmRollupProjection（从 ledger 重建 rollup）
- 新增 `services/core/swarmRollupProjection.ts`：纯函数 `rebuildRunDetail(events)` 按 seq 回放 ledger 事件 → 重建 `SwarmRunDetail`（run rollup + agents rollup + 可选 events）。`parallelPeak` 用"按时刻数 running agent 取峰值"重算（不依赖运行时内存态）。纯函数、零 DB。
- **验证**：typecheck；`swarmRollupProjection.test.ts`：从一组 ledger 事件重建出 run+agents 全字段（tokens/cost/counts/status/duration/error）；parallelPeak 由 running-count 峰值正确算出；空/缺事件 fail-safe（不抛）；末值覆盖语义（同 agent 多次 snapshot 取最后）。

### 步骤 4 — 影子对账 + 诊断出口（交付证据：重建==现存）
- 新增 `services/core/swarmReconcile.ts`：`reconcileRun(rebuilt, stored)` 逐字段比对 run+agents，产出 `{ runId, match: boolean, drift: Array<{field, rebuilt, stored}> }`（parallelPeak 允许小偏差阈值）。
- `databaseService.ts`：`reconcileSwarmRun(runId)`（读 ledger→重建→读 rollup 表→对账）fail-safe。
- `diagnostics.ipc.ts`：新增 `case 'swarmReconcile'`（payload.runId → drift 报告）。
- **验证**：typecheck；`swarmReconcile.test.ts` + `diagnostics.swarmReconcile.test.ts`：真实 in-memory DB 跑一个 swarm 生命周期（既写 rollup 又写 ledger）→ 对账**全字段一致**（match=true，drift 空）= **D2 影子对账交付证据**；构造一处人为不一致 → drift 精确指出字段。

### 步骤 5 — 切换降级（读真理源切到 ledger，rollup 退为回退缓存）
- `databaseService.ts`：新增 `getSwarmRunDetailPreferLedger(runId)`——ledger 有该 run 则用投影（真理源），无则**回退** `swarmTraceRepo.getRunDetail`（缓存/历史 run）。3a 的 `readSwarmRunsForSession`/`readSwarmEventsForRuns` 接此优先级（一本账协同 lane 即"以事件流为真理源"）。
- `swarm.ipc.ts` `getRunDetail`：经此优先级（UI 详情也以 ledger 为真理源，回退兼容老 run）。**写路径不动**，rollup 继续写（缓存）。
- **验证**：typecheck；`swarmDemotion.integration.test.ts`：有 ledger 的 run 走投影、字段与对账一致；无 ledger 的老 run 回退 rollup 仍读出；rollup 表被人为改坏但 ledger 完整时，读出以 ledger 为准（证明真理源已切换）；`sessionLedger.integration.test.ts` 协同 lane 回归绿。

### 步骤 6 — 对抗审查 + 证据归档
- **对抗审查**（动了 Swarm 持久化路径 + 共享 DB + 新契约，按用户铁律）：对 `swarmTraceWriter` 并行追加点 + `swarmRollupProjection` 重建逻辑 + `swarmReconcile` + 降级回退优先级跑 `codex-audit`/`/multi-review` 或独立 reviewer 子代理，重点查：并行追加是否真 fail-safe 不影响运行、seq 单调与并发、parallelPeak 重建精度、降级回退边界（ledger 半套/缺 run_closed 时不能读出错误真理源）、append-only 不变量。发现项 TDD 修。
- 证据归档 `docs/plans/evidence/2026-06-16-ledger-phase3b-*`（baseline/各步 + 对账"重建==现存"证据 + 降级"以 ledger 为准"证据 + 对抗审查结论）。

## 4. 验证汇总

| 步 | typecheck | 单测 | 回归 | 证据 |
|---|---|---|---|---|
| 0 | ✅ | — | swarmTraceWriter/File/sessionLedger | baseline |
| 1 | ✅ | ledger 仓储 append/round-trip/append-only/按run聚合 | — | step1 |
| 2 | ✅ | 并行追加成套 + 不影响运行/持久化 | swarmTraceWriter 回归 | step2 |
| 3 | ✅ | 从 ledger 重建全字段 + parallelPeak 峰值 + fail-safe | — | step3 |
| 4 | ✅ | 对账全字段一致(招牌) + drift 精确定位 | — | step4（对账证据） |
| 5 | ✅ | ledger优先/老run回退/rollup坏以ledger为准 | sessionLedger 协同 lane 回归 | step5（降级证据） |
| 6 | ✅ | 对抗审查发现项回归 | 全量 swarm + services + ipc 回归 | 对抗审查结论 + 归档 |

证据归档 `docs/plans/evidence/2026-06-16-ledger-phase3b-*`。

## 5. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 并行追加拖垮 swarm 运行/持久化 | SwarmTraceWriter 内 try/catch 吞错 + fire-and-forget；现有写入一行不改 | 各步独立 commit，revert 追加点即回到纯 rollup |
| 从 ledger 重建出错的 rollup 被当真理源读出 | 降级带回退兜底（ledger 缺/半套走 rollup）；切换前必过影子对账全字段一致 | revert 步骤 5（读路径回退步），写入与对账保留 |
| parallelPeak 重建偏差 | 按时刻 running-count 峰值重算（比依赖事件统计更准）；对账设小偏差阈值并显式标注 | — |
| 新表/索引影响现有 schema | 仅 `CREATE TABLE IF NOT EXISTS` 新表，不碰旧表；step0 schema 回归 | revert schema 改动 |
| append-only 被破坏 | SwarmLedgerRepository 不实现 update/delete；单测断言 | — |
| 时间戳裸 Date.now() 违规 | ledger append 走参数化 recordedAt | — |
| 并发/重启同 runId | ledger 按 (run_id, seq) 记，run_started 带 startedAt 区分重启；投影按 seq 回放 | — |

## 6. 与四期的衔接
- 第四期"后台定时对账 + 老库迁移"可直接复用本期 `swarmReconcile`（从"按需手查"升级为"定时跑 + 自动修"）+ ledger 作为迁移的权威源。

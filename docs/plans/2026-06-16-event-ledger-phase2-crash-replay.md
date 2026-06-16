# 事件账本 第二期 · 崩溃重放（实施计划）

> 日期: 2026-06-16 · 作者: Neo · 状态: 执行中
> 上游决策: ADR-022（已 accepted，Q1=C 混合 / Q2=Y 最小切口）§四 第二期
> 前提: 用户不读代码、不做 review。质量由每步可执行验证闸门保证，验证不过不进下一步。无新增 ADR 决策点。

## 1. 目标与边界

**目标**：让程序崩溃重启后，能从总账把"崩溃前正在做的事"**重放/重建回来**，而不只是把会话状态从 `running` 翻成 `interrupted`。交付证据：演示一次"运行中强杀进程 → 重启 → 现场被完整恢复"（含正在执行的工具名 + 完整参数 + 起始时刻 + 归属 session）。

**现状缺口（为什么第一期不够）**：
- 第一期账本 `permission_decisions` 只记"决策完成"这个**点事件**（allow/deny 一落地就记一条），抓不到"工具被放行后、真正执行过程中的崩溃"。
- 现有崩溃处理 `SessionRepository.markCrashedActiveSessions()`（databaseService 初始化时跑）只把 `running/paused/cancelling → interrupted`、`queued → orphaned`，**只翻状态位，不知道崩溃那一刻具体在执行什么工具、参数是什么**——正是 ADR 批评的"只打中断标记"。

**核心设计（append-only event-sourcing，承接 ADR §四 C 混合）**：
给账本加"工具执行生命周期"两个不可变事件：
- `begin`：一个工具通过全部权限闸、即将真正执行（`resolver.execute` 前）时追加一条，带 `execution_id`（关联键）+ `session_id` + `tool_name` + `summary` + `params_json` + `recorded_at`。
- `complete`：执行返回/抛错/被恢复确认时追加一条，带同一 `execution_id` + `status`（`success`/`error`/`recovered`）。
- **不 UPDATE 旧行**（append-only 不变量）。"崩溃那一刻正在执行的工具" = 有 `begin` 无 `complete` 的 `execution_id`。重启时把这些未闭合执行 reduce 出来 = "现场"。

**纯增量边界（明确不做）**：
- 不动现有任何表（messages/telemetry/swarm/task/permission_decisions/sessions），只**新增** `tool_execution_events` 一张 append-only 表。
- 不改 `markCrashedActiveSessions` 现有行为（中断标记保留，恢复是它的增强而非替换）。
- 不改权限判定逻辑、不改工具执行结果。begin/complete 落库全程 fail-safe（try/catch 吞错），DB 任何问题**绝不影响**工具执行。
- 不做"自动续跑 agent loop"——本期交付到"重建出可被消费的恢复现场快照 + 经诊断出口读回"为止；真正把快照喂回 agent 续跑是后续期/接线工作，不在本期硬门内。
- 不迁移其它账本（第三期）、不做后台对账（第四期）。

## 2. 现状锚点（file:line）

```
会话状态机:        src/shared/contract/session.ts:12              SessionStatus（含 interrupted/orphaned）
中断标记:          SessionRepository.markCrashedActiveSessions()  databaseService.ts:199 处调用
工具真实执行:      src/main/tools/toolExecutor.ts:821             resolver.execute(...)（try/catch/finally 内）
sessionId 贯通:    toolExecutor ExecuteOptions.sessionId          toolExecutionEngine.ts:676 灌入
第一期接入模式:    databaseService.ts:197 / 240-271              new PermissionDecisionRepository + appendPermissionDecision()
DB 初始化挂载点:   databaseService._doInitialize() :199           markCrashedActiveSessions 旁，恢复扫描最佳挂载点
诊断读出口:        src/main/ipc/diagnostics.ipc.ts case 'decisions' 第一期持久化证据出口，照此加 'recovery'
append 仓储先例:   repositories/PermissionDecisionRepository.ts   只 INSERT/SELECT
```

## 3. 分步实现（每步先写失败测试后实现，独立 commit）

### 步骤 0 — 基线
`npm run typecheck` + 跑 `permissionDecisionRepository.test.ts` / `toolExecutor.decisionTrace.test.ts` 留绿底。

### 步骤 1 — 新表 + 仓储（append-only 执行生命周期）
- `schema.ts`：新增 `tool_execution_events`（id 自增、execution_id、session_id 可空、tool_name、summary、params_json、phase（begin|complete）、status 可空、error 可空、recorded_at）+ 按 (execution_id)、(session_id, recorded_at)、(phase, recorded_at) 建索引。幂等 `CREATE TABLE IF NOT EXISTS`。
- 新增 `repositories/ToolExecutionEventRepository.ts`：`appendBegin(input)` + `appendComplete(input)` + `getOpenExecutions()`（有 begin 无 complete）+ `getRecent(limit)` + `count()`。**只 INSERT/SELECT，无 UPDATE/DELETE**。时间戳走参数（禁裸 Date.now()）。
- **验证**：typecheck；`toolExecutionEventRepository.test.ts`：begin→getOpen 取回（params round-trip）；append complete 后该执行不再 open；append-only（无 update/delete 方法）；count 递增；多 execution 并存只 open 未闭合的。

### 步骤 2 — 崩溃恢复服务（重建现场）
- 新增 `services/core/crashRecovery.ts`：`buildRecoverySnapshot(repo)` 读 `getOpenExecutions()` → 产出结构化 `RecoverySnapshot { recoveredAt, totalInFlight, sessions: [{ sessionId, operations: [{ executionId, toolName, summary, params, startedAt, elapsedMs }] }] }`；`acknowledgeRecovery(repo, snapshot, recordedAt)` 给每个被恢复执行 append 一条 `complete{status:'recovered'}`（append-only 地"闭合"，避免下次重启重复浮现）。
- **验证**：typecheck；`crashRecovery.test.ts`：
  - 未闭合执行 → 快照按 session 分组、参数完整重建；
  - **强杀→重启重放（招牌证据）**：用真实文件 DB，appendBegin 后**不** appendComplete（模拟 SIGKILL）→ `db.close()`（模拟进程死亡）→ 重新打开同一 DB 文件（模拟重启）→ buildRecoverySnapshot 完整重建出在飞执行 + 精确参数；
  - acknowledgeRecovery 后 getOpenExecutions 清空、再次重启不重复浮现。

### 步骤 3 — 接入 toolExecutor + databaseService 暴露
- `databaseService.ts`：实例化 `toolExecutionEventRepo` + 暴露 `appendToolExecutionBegin/Complete`（fail-safe，照 appendPermissionDecision）+ `getOpenToolExecutions()`。
- `toolExecutor.ts`：`resolver.execute` 前生成 `executionId` + fail-safe `appendToolExecutionBegin`（带 `options.sessionId`）；执行成功/抛错后 fail-safe `appendToolExecutionComplete`（status 区分）。任何 DB 失败静默吞、不影响执行。
- **验证**：typecheck；`toolExecutor.decisionTrace.test.ts` 回归全绿（执行路径不变）；新增断言：执行一次工具后库里有成对 begin+complete；工具抛错时 complete.status='error'；DB 不可用时工具仍正常执行（不抛）。

### 步骤 4 — 启动恢复扫描 + 诊断出口（交付证据）
- `databaseService._doInitialize()`：`markCrashedActiveSessions` 之后，跑一次 `buildRecoverySnapshot` 并缓存 `lastRecoverySnapshot` + `acknowledgeRecovery`（闭合），warn 日志打出在飞执行数。暴露 `getLastRecoverySnapshot()`。
- `diagnostics.ipc.ts` 新增 `case 'recovery'`：返回 `lastRecoverySnapshot`（在飞执行数、按 session 的工具+参数+起始）。
- **验证**：typecheck；`diagnostics.recovery.test.ts`：DB 里塞未闭合执行→初始化扫描→经诊断出口读回（重建出工具名+参数+session）= ADR 第二期交付证据（确定性形式）。

## 4. 验证汇总

| 步 | typecheck | 单测 | 回归 | 证据 |
|---|---|---|---|---|
| 0 | ✅ | — | permissionDecisionRepo/decisionTrace | baseline log |
| 1 | ✅ | begin/getOpen/round-trip/append-only/count | — | step1 log |
| 2 | ✅ | 快照重建 + 强杀重启重放 + 闭合幂等 | — | step2 log（重放证据） |
| 3 | ✅ | 工具执行成对落库 + error + DB 不可用不抛 | decisionTrace 回归 | step3 log |
| 4 | ✅ | 启动扫描 + 诊断出口读回现场 | — | step4 log（交付证据） |

证据归档 `docs/plans/evidence/2026-06-16-ledger-phase2-*`。

## 5. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| begin/complete 落库拖垮工具执行 | toolExecutor 内 try/catch 吞错 + fire-and-forget | 各步独立 commit，revert 接入步即回到无生命周期事件 |
| 新表/索引影响现有 schema | 仅 `CREATE TABLE IF NOT EXISTS` 新表，不碰旧表；step0 schema 回归 | revert schema 改动 |
| 未闭合执行永久浮现/重复恢复 | acknowledgeRecovery append `recovered` 闭合，重启幂等 | — |
| append-only 被破坏 | 仓储不实现 update/delete；单测断言 | — |
| 时间戳裸 Date.now() 违规 | 仓储 append 走参数化时间戳 | — |

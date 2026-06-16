# 事件账本 第一期 · 权限决策链落库（实施计划）

> 日期: 2026-06-16 · 作者: Neo · 状态: 待执行
> 上游决策: ADR-022（已 accepted，Q1=C 混合 / Q2=Y 最小切口 / 第一期=权限决策链）
> 前提: 用户不读代码、不做 review。质量由每步可执行验证闸门保证，验证不过不进下一步。

## 1. 目标与边界

**目标**：把"权限决策链"立为事件账本第一期试水场景——每一次 allow/deny/ask 决策**持久化落库**（当前只在内存 50 条环形缓冲，重启即丢）。交付证据：能从库里读回"每一次允许/拒绝都留下完整决策流水（含多层 trace）"，重启不丢。

**纯增量边界（明确不做）**：
- 不动现有任何表（messages/telemetry/swarm/task）。只**新增** `permission_decisions` 一张 append-only 表。
- 不改 `recordDecision` 的判定逻辑、不改 `DecisionTrace` 形状、不改权限放行规则。只在 `recordDecision` 末尾**追加**一条 fail-safe 的持久化写入。
- 不做崩溃恢复重放（第二期）、不迁移其它账本（第三期）、不做后台对账（第四期）。
- DB 写入失败**绝不能**影响工具执行/权限判定（try/catch 吞错 + 内存缓冲仍在）。

## 2. 现状锚点（file:line）

```
内存决策历史:   src/main/security/decisionHistory.ts            getDecisionHistory().record()（环形 50，易失）
决策记录入口:   src/main/tools/toolExecutor.ts:56               recordDecision()（13 处调用，全经此）
决策 trace 契约: src/shared/contract/decisionTrace.ts            DecisionTrace { toolName, finalOutcome, steps[], totalDurationMs }
DB 网关/注册:   src/main/services/core/databaseService.ts:187    各 repo new XxxRepository(this.db)
schema:        src/main/services/core/database/schema.ts        applySchema()，append-only 先例 session_task_events
append 先例:    repositories/SwarmTraceRepository.ts / SessionRepository.appendSessionTaskEvents()
诊断读出口:     src/main/ipc/diagnostics.ipc.ts:40               case 'decisions'（现读内存）
```

## 3. 分步实现（每步先实现后验证，独立 commit）

### 步骤 0 — 基线
`npm run typecheck` + 跑 `toolExecutor.decisionTrace.test.ts` / `databaseSchema.experiments.test.ts` 留绿底。

### 步骤 1 — 新表 + 仓储（append-only）
- `schema.ts`：新增 `permission_decisions` 表（id 自增、session_id 可空、tool_name、summary、final_outcome、history_outcome、reason、duration_ms、recorded_at、trace_json）+ 按 (session_id, recorded_at) 与 (tool_name, recorded_at) 建索引。幂等 `CREATE TABLE IF NOT EXISTS`。
- 新增 `repositories/PermissionDecisionRepository.ts`：`append(input, recordedAt?)`（**禁止裸 Date.now()**，时间戳走参数，未传才 fallback）+ `getRecent(limit)` + `getBySession(sessionId, limit)` + `count()`。**只有 INSERT/SELECT，无 UPDATE/DELETE**（append-only 不变量）。
- **验证**：typecheck；新增 `tests/unit/services/permissionDecisionRepository.test.ts`（in-memory better-sqlite3）：append→getRecent 取回；trace_json round-trip；append-only（仓储不暴露任何 update/delete 方法）；count 递增。

### 步骤 2 — 注册 + 接入 recordDecision（fail-safe 持久化）
- `databaseService.ts`：实例化 + 暴露 `permissionDecisionRepo`（getter）。
- `toolExecutor.ts:recordDecision()`：内存 record 之后，**try/catch 包裹**地追加一条 DB 持久化（拿不到 db / 写失败都静默吞，不抛）。
- **验证**：typecheck；既有 `toolExecutor.decisionTrace.test.ts` 回归全绿（内存路径不变）；新增断言：执行一次工具后，库里能查到对应决策行（outcome/reason/trace 对得上）；模拟 DB 不可用时工具仍正常执行（不抛）。

### 步骤 3 — 诊断出口读库（持久化证据）
- `diagnostics.ipc.ts` `case 'decisions'`：在内存 recent 之外，增加从库读 `total`/`recent`（持久、跨重启）。保持向后兼容字段。
- **验证**：typecheck；新增测试：写入若干决策→经诊断出口读回（含 allow + deny 各一，trace 步数对得上）= ADR 第一期交付证据（确定性形式）。

## 4. 验证汇总

| 步 | typecheck | 单测 | 回归 | 证据 |
|---|---|---|---|---|
| 0 | ✅ | — | decisionTrace/schema | baseline log |
| 1 | ✅ | repo append/round-trip/append-only/count | — | step1 log |
| 2 | ✅ | 工具执行落库 + DB 不可用不抛 | decisionTrace 回归 | step2 log |
| 3 | ✅ | 诊断出口读回 allow+deny+trace | — | step3 log（交付证据） |

证据归档 `docs/plans/evidence/2026-06-16-ledger-*`。

## 5. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| DB 写入拖垮工具执行 | recordDecision 内 try/catch 吞错 + 内存缓冲保底；fire-and-forget | 各步独立 commit，revert 接入步即回到纯内存 |
| 新表/索引影响现有 schema | 仅 `CREATE TABLE IF NOT EXISTS` 新表，不碰旧表；step0 schema 测试回归 | revert schema 改动 |
| 时间戳裸 Date.now() 违规 | 仓储 append 走参数化时间戳 | — |
| append-only 被破坏 | 仓储不实现 update/delete；单测断言 | — |

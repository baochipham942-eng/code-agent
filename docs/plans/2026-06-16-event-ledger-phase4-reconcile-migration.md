# 事件账本 第四期 · 一致性兜底（后台对账）+ 老数据迁移（实施计划）

> 日期: 2026-06-16 · 作者: Neo · 状态: 待执行（已写计划，等用户拍板后动手）
> 上游决策: [ADR-022](../decisions/022-append-only-event-ledger-spine.md) §四第四期 + [ADR-024](../decisions/024-event-ledger-phase4-background-reconcile-and-migration.md)（Q1=A1 注册+开但只报告 / Q2=B1 默认跳过+可选 backfill / **Q3=对账绑定 Dream**，已 accepted）
> 分支: `feat/event-ledger-phase4`（基于最新 main，含 1/2/3a/3b）
> 前提: 用户不读代码、不做 review。质量由每步可执行验证闸门保证。迁移类与后台调度类是高风险点，走 TDD + 对抗审查。

## 1. 目标与边界

**目标**：兑现 ADR-022 §四第四期"一致性兜底 + 老数据迁移"：
- ① **后台对账（绑定 Dream）**：把 3b 的"按需手查"影子对账（`reconcileRun` 诊断出口）升级为**无人值守对账**——**绑定 Dream**：在 Dream（每 7 天的离线维护窗口）跑完记忆巩固后，作为**确定性后置步骤** fail-safe 遍历 Swarm run，比对"从 ledger 重建的 rollup" vs "现存 rollup 缓存"，产出对账报告 + 落运行证据（默认只报告）。认知隐喻：睡眠的离线维护里一并做"一致性重整"。
- ② **偏差自愈（默认 OFF 写闸门）**：发现 drift 时，**仅在显式开启写闸门、且 ledger 为已闭合真理源**的前提下，从 ledger 确定性重建 rollup 缓存。
- ③ **老库迁移（默认跳过 + opt-in）**：存量老 run（有 rollup、无 ledger）默认靠读路径回退、不动；另提供幂等+事务+可回滚的 opt-in backfill（从 rollup 反向重建 ledger）。

**交付证据**：一份可演示的对账扫描报告（`ReconcileScanReport`，含覆盖范围/匹配/偏差/跳过/错误）+ 老库平滑升级的确定性验证（合成"旧库"→读正常、对账标记 ledger-missing、opt-in backfill 后对齐、重跑幂等、注入错误事务回滚）。

**纯增量 + 可回退边界（明确不做）**：
- 不改任何现有写路径的**默认行为**：缓存重建写动作默认关（dryRun=true）；老库 backfill 默认不在开机/不随 Dream 跑。
- **不动共享调度基建**：对账绑定 Dream（dreamExecutor 收尾薄调用），**不新增 cron action 类型、不改 cronService dispatch/contract**（Q3 决策的红利——比独立 cron job 切口更小、风险更低）。
- 对账后置步骤全程 **fail-safe**：吞错 + 不影响 Dream 已完成的记忆写入，反之亦然（不连坐）。
- 不新建表：复用 3b 的 `swarm_run_ledger` + Dream 的 `cron_executions`（运行证据）。
- 不动 `reconcileRun`/`rebuildRunDetail`/`getSwarmRunDetailPreferLedger` 的既有签名与不变量（沿用 3b HIGH-1：半套账本绝不覆盖完整 rollup）。
- 新增逻辑全部进**独立模块**，databaseService（已 1193 物理行、紧贴 1000 有效行 ESLint 硬门）只加极薄委托（能不加则不加）。
- 后台对账 fail-safe：扫描/重建吞错、单 run 错误隔离，绝不影响 app 启动 / swarm 运行 / 现有持久化。

## 2. 现状锚点（file:line，调研结论）

```
# 绑定点：Dream（离线维护窗口）+ 运行证据
Dream cron job:           src/main/services/memory/dreamScheduler.ts   每 7 天(DREAM_INTERVAL_DAYS)；action.type='agent' agentType='dream' prompt='/dream --auto'
Dream 执行入口(★接入点):  src/main/services/memory/dreamExecutor.ts executeDreamRun(request,overrides)  跑完 runDreamMemoryConsolidation→return report；**对账后置步骤插在此收尾处**
  auto vs 手动:           dreamExecutor.ts isAutoTriggered(args)       cron 走 '/dream --auto'，手动走 /dream（两者都经此入口）
Dream 五阶段编排:         src/main/services/memory/dreamMemoryService.ts runDreamMemoryConsolidation / formatDreamRunReport
executor 注册表:          src/main/services/skills/skillExecutorRegistry.ts registerSkillExecutor（Dream 经此桥接，确定性 executor 通用扩展点）
Dream job 注册:           src/main/app/initBackgroundServices.ts:622-639 syncDreamCronJob + registerDreamSkillExecutor
运行证据持久化:           src/main/cron/cronService.ts saveExecutionToDatabase(~1201) Dream(cron job) auto 跑落 cron_executions（result 带 Dream 报告+对账摘要）
运行证据表:               src/main/services/core/database/schema.ts:375-411  cron_jobs / cron_executions
dry-run 范式:             src/shared/constants/memory.ts:71-92         MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT=true（默认只报告，克隆此模式做写闸门）
dry-run 消费:             src/main/lightMemory/consolidation.ts(~283-413) dryRun 闸门 gate 写动作（克隆此模式）

# 复用：3b 对账/重建/降级（纯函数，已现成）
影子对账(纯函数):          src/main/services/core/swarmReconcile.ts:42-97   reconcileRun(rebuilt, stored, runId) → ReconcileResult{match,drift[],note}
确定性重建(纯函数):        src/main/services/core/swarmRollupProjection.ts:60-130  rebuildRunDetail(events) → SwarmRunDetail
降级读(真理源优先):        src/main/services/core/databaseService.ts(~384-396) getSwarmRunDetailPreferLedger（ledger 含 run_closed 才用，否则回退 rollup）
诊断出口(按需查):          src/main/ipc/diagnostics.ipc.ts:159-175      action='swarmReconcile' → reconcileSwarmRun(runId)
DB facade 委托:           databaseService.ts reconcileSwarmRun/getSwarmRunDetailPreferLedger/getSwarmLedgerByRun/listSwarmLedgerRunIds
ledger 仓储:              src/main/services/core/repositories/SwarmLedgerRepository.ts:87  append/getByRun/listRunIds/count（仅 INSERT/SELECT）
rollup 仓储(读缓存):       src/main/services/core/repositories/SwarmTraceRepository.ts     getRunDetail/listRuns + startRun/upsertAgent/closeRun（写缓存）
ledger 表:               schema.ts:250-263                            swarm_run_ledger（run_id/seq/event_kind/agent_id/payload_json/recorded_at；UNIQUE(run_id,seq)）

# 复用：迁移/backfill 范式 + 引导
backfill 范式:            databaseService.ts(~231-236)                 backfillSessionMessagesFts/...（幂等前置检查 + db.transaction() + 非阻塞）
DB 引导/迁移执行:          databaseService.ts _doInitialize(~175-250)   better-sqlite3；applySchema/applyXxxMigrations；WAL；无 PRAGMA user_version
迁移文件:                src/main/services/core/database/migrations.ts safeExec 幂等 DDL
关停清理:                src/main/services/infra/gracefulShutdown.ts:64 onShutdown(name,handler,priority)（如需清 interval/句柄）

# 测试基线
                         tests/unit/.../swarmReconcile*/swarmRollupProjection*/SwarmLedgerRepository* 现有绿底
                         tests/unit/cron/* CronService 现有绿底
```

## 3. 分步实现（每步先写失败测试后实现，独立 commit）

### 步骤 0 — 基线
`npm run typecheck` + 跑 cron、swarmReconcile、swarmRollupProjection、SwarmLedgerRepository 相关测试留绿底。证据：`evidence/2026-06-16-ledger-phase4-step0-*.log`。

### 步骤 1 — 对账扫描核心 `swarmReconcileService.ts`（纯只读，TDD）
- 新增 `src/main/services/core/swarmReconcileService.ts`：`runReconcileScan(reader, options) → ReconcileScanReport`。
  - `reader` 注入式接口（`listRunIds`/`getLedgerByRun`/`getStoredRunDetail`），便于无 DB 单测；options 含**时间窗/水位线**（默认只扫近 N 或上次成功水位之后，**不静默截断**——报告里写明扫了哪些、漏了哪些）。
  - 逐 run：`rebuildRunDetail(ledger)` + `reconcileRun(rebuilt, stored, runId)`，单 run 错误隔离（计入 errors，不中断扫描）。
  - 聚合 `ReconcileScanReport { generatedAt, window, scannedCount, matched, drifted[], skippedLedgerMissing[], errors[], coverageNote }`。
  - **本步零写入**（report-only 核心）。
- `shared/contract/` 加 `ReconcileScanReport` 类型。
- **验证**：typecheck；`swarmReconcileService.test.ts`（in-memory/fake reader）：全匹配；含 drift；ledger-missing 归 skipped（非 error/drift）；单 run 抛错被隔离且计入 errors；水位窗口选取正确；coverageNote 如实反映覆盖范围（无静默截断）。

### 步骤 2 — 绑定 Dream：对账作为 Dream 收尾的确定性后置步骤（默认开、report-only、落证据）
- `src/shared/constants/`：加 `SWARM_RECONCILE { RECONCILE_DEFAULT_MUTATION:false（写闸门默认关）, WINDOW, REPORT_PATH }`（克隆 MEMORY_CONSOLIDATION 的 dry-run 风格；**频率不另立常量，跟 Dream 的 `DREAM_INTERVAL_DAYS` 走**）。
- `dreamExecutor.ts` `executeDreamRun` 收尾：在 `runDreamMemoryConsolidation` 返回后，**fail-safe（try/catch 吞错）** 调用步骤 1 的 `runReconcileScan`（report-only，写闸门关），把对账摘要 append 进返回的 Dream 报告（→ 落进 Dream cron job 的 `cron_executions.result` = 运行证据）；同时由对账服务自身归档一份报告（运行证据双保险）。**对账抛错绝不影响 Dream 已完成的记忆写入**（仅记日志）。
- **不动** `cronService` dispatch / `cron.ts` contract / 不新增 action 类型 / 不新注册 job（Q3 红利）。手动 `/dream` 与 cron `/dream --auto` 都经 `executeDreamRun` → 两者都会顺带对账（auto 才是无人值守证据场景，报告标注 auto/manual）。
- **验证**：typecheck；`dreamExecutor` targeted 测试：Dream 跑完后对账被调用且摘要进报告；**注入对账抛错 → Dream 报告仍正常返回、记忆写入不受影响（不连坐）**；**断言本步无任何 rollup 写入**（写闸门关，spy 写方法零调用）；auto/manual 标注正确。证据：`evidence/2026-06-16-ledger-phase4-step2-*.log`。

### 步骤 3 — 报告归档 + 诊断出口升级（可演示证据）
- 升级 `diagnostics.ipc.ts`：除现有按 run 的 `swarmReconcile`，新增"扫描聚合"出口，按需返回 `ReconcileScanReport`（供手动拉演示报告）。
- 交付时把一份样例 `ReconcileScanReport`（含 matched/drifted/skipped）渲染成可读 md 归档到 `evidence/`。
- **验证**：跑扫描产出样例报告并归档；typecheck + 诊断出口 targeted 测试。

### 步骤 4 — 偏差自愈：发现 drift 自动重建 rollup 缓存（**默认 OFF 写闸门**，高风险，TDD + 对抗审查）
- 在 `swarmReconcileService`：仅当**写闸门开**（`SWARM_RECONCILE.RECONCILE_DEFAULT_MUTATION=false`，默认关；绑定 Dream 的对账调用默认传 report-only）且某 run **drift 且 ledger 为已闭合真理源（含 run_closed）**时，从 `rebuildRunDetail` 确定性结果重建 rollup 缓存（写 `swarm_runs`/`swarm_run_agents`）。
  - 复用 3b 不变量：**半套账本（running、无 run_closed）绝不重建/覆盖**（沿用 HIGH-1 修复精神）；重建幂等（确定性结果，重复重建无副作用）；fail-safe（吞错、单 run 隔离）。
  - 重建写入走独立薄方法（rollup 仓储现有 upsert 能力），databaseService 不增逻辑或仅极薄委托。
- **验证（TDD）**：写闸门开 → drift+闭合 run 的缓存被重建到与 ledger 对齐，重跑对账 match；写闸门关（默认）→ 零写入；半套账本（running）→ 永不重建；重建幂等（连重建两次结果一致）。证据：`evidence/2026-06-16-ledger-phase4-step4-*.log`。
- **对抗审查**：本步动 Swarm 读缓存写路径 + 共享调度 dispatch → `/codex-audit` 或 `/multi-review`，重点查"写闸门是否真默认关、是否可能用半套账本覆盖完整 rollup、错误是否会冒泡影响运行"。

### 步骤 5 — 老库一次性迁移 `backfillSwarmLedger.ts`（B1 默认跳过 + opt-in，迁移类，TDD + 可回滚）
- 新增 `src/main/services/core/database/backfillSwarmLedger.ts`：`backfillSwarmLedger(db, options) → { backfilled, skipped, errors }`。
  - 对每个**有 rollup、无 ledger** 的老 run：从 stored rollup 反向重建 ledger 事件（`run_started` + 每 agent 末值 `agent_snapshot` + `run_closed`），在 **`db.transaction()` 内 INSERT**（出错整笔回滚）。
  - **幂等**：前置检查"该 run 已有任意 ledger 行则跳过"（计入 skipped）。
  - **B1：默认不在开机自动跑**——仅经 opt-in（诊断出口 / 显式调用）触发。
- **验证（TDD + 向后兼容确定性验证）**：
  1. 合成"旧库"（只有 rollup 行、零 ledger）→ 断言 app 照常读出 run（走 rollup 回退）、对账把这些 run 归 `skippedLedgerMissing`（非 error/drift）——**证明不迁移也不坏**。
  2. 跑 opt-in backfill → ledger 生成、`getSwarmRunDetailPreferLedger` 改以 ledger 为准、对账 match。
  3. 重跑 backfill → 全 skipped（**幂等**）。
  4. 注入 backfill 中途错误 → 断言事务回滚、DB 与跑前一致（**可回滚、不毁数据**）。
- 证据：`evidence/2026-06-16-ledger-phase4-step5-*.log`（含旧库升级确定性验证）。
- **对抗审查**：迁移类 → `/codex-audit`，重点查事务边界、幂等前置条件、是否可能部分写入留脏数据、是否破坏老 run 读路径。

### 步骤 6 — 收尾：对抗审查闭环 + 交付证据归档
- 汇总步骤 4/5 的对抗审查（高风险点：缓存重建写路径、老库迁移）修完 HIGH/MED。
- 归档 `evidence/2026-06-16-ledger-phase4-reconcile-migration.md`：typecheck 日志、各步 targeted 测试通过数、样例对账扫描报告、旧库升级确定性验证日志。

## 4. 验证闸门（每步交付前）
- ① `npm run typecheck` 必过；② 受影响模块 targeted 测试；③ 迁移/写闸门步骤走 TDD（先失败测试）；④ 高风险点（共享调度 dispatch / 写路径 / 迁移）做对抗审查（codex-audit 或 multi-review）。
- 自审：`git diff --stat` 逐文件查变更行数；确认 databaseService 不超 1000 有效行（新逻辑进独立模块）；`grep Date.now()` 自检（写入走参数时间戳）。

## 5. 风险与缓解
| 风险 | 缓解 |
|---|---|
| 对账拖累 Dream / Dream 失败连坐对账 | 对账是 Dream 收尾的**独立确定性后置步骤**，try/catch 吞错；Dream 记忆写入先于对账完成；两者互不影响（步骤 2 注入错误测试验证）|
| 缓存重建写路径误伤 rollup | 默认 OFF 写闸门；仅 ledger 已闭合时重建；半套账本绝不覆盖（沿用 3b HIGH-1）；fail-safe 隔离；TDD + 对抗审查 |
| 迁移毁老数据 | 默认跳过（B1）；opt-in + `db.transaction()` 可回滚 + 幂等前置检查；旧库升级确定性验证；TDD + 对抗审查 |
| databaseService 撞 1000 行硬门 | 新逻辑全进独立模块，facade 仅极薄委托或不动 |
| 静默截断扫描范围 | 报告 `coverageNote` 如实写明扫描窗口/覆盖/遗漏，不做无声 top-N |

## 6. 提交纪律
- 每步独立 commit（步骤 1 扫描核心 / 步骤 2 绑定 Dream 对账 / 步骤 3 诊断出口 / 步骤 4 写闸门自愈 / 步骤 5 迁移 / 步骤 6 收尾）。
- 先别 push，等用户拍板。证据归档到 `docs/plans/evidence/`。

# 事件账本 第四期 · 交付证据（后台对账绑定 Dream + 偏差自愈 + 老库迁移）

> 日期: 2026-06-16 · 分支: `feat/event-ledger-phase4`（基于含 1/2/3a/3b 的 main）
> 上游: [ADR-024](../../decisions/024-event-ledger-phase4-background-reconcile-and-migration.md)（Q1=A1 注册+开但只报告 / Q2=B1 默认跳过+opt-in / Q3=对账绑定 Dream）

## 分层验证闸门
- **typecheck**：全程 `npm run typecheck` 绿（基线 + 每步）。
- **第四期 + 回归测试一把跑：49 passed / 0 failed**（含对账/写闸门/迁移新测 + swarmDemotion/rollupProjection/traceWriter/diagnostics 回归）。
- **eslint**：改动文件 `No issues found`；husky pre-commit 闸门每步通过。
- **提交纪律**：6 步各独立 commit（docs → 步骤1扫描 → 步骤2绑Dream → 步骤3诊断出口 → 步骤4写闸门 → 步骤5迁移 → 步骤6审查收尾）。

## 各步骤测试证据
| 步 | 内容 | 关键测试 |
|---|---|---|
| 1 | 对账扫描核心（纯只读、注入式 reader） | `swarmReconcileService.test.ts`：match / drift / ledger-missing / in-progress 跳过 / 单 run error 隔离 / coverageNote 不静默截断 |
| 2 | 绑定 Dream（收尾确定性后置步骤） | `dreamExecutor.test.ts`：对账摘要并入 Dream 报告；**对账抛错不连坐**（Dream 记忆写入不受影响）；formatReconcileScanReport / createDatabaseReconcileReader 单测 |
| 3 | 诊断出口 `swarmReconcileScan`（只读） | `diagnostics.swarmReconcileScan.test.ts`：返回扫描报告 + 读账抛错 fail-safe 不 500 |
| 4 | 偏差自愈写闸门（**默认关**） | 单元：关默认不写 / 开则重建 / running 永不重建 / writer 错误隔离 / stored 缺失不触发写。集成（真实 sqlite）：drift→从 ledger 确定性重建对齐、**幂等**（再扫不再重建）、**默认关绝不改写** |
| 5 | 老库迁移（**默认跳过 + opt-in**） | 集成（真实 sqlite）：旧库不迁移也能读（向后兼容）、backfill 后与 rollup 对账一致、**幂等**（重跑全跳过无重复）、**事务回滚**（中途出错不留脏数据、老库 rollup 完好）；诊断出口 `swarmLedgerBackfill` fail-safe |

## 三硬规则落地（自动化产出验收）
1. **硬门代码化**：写动作 = 代码级 `rebuildOnDrift` 闸门（默认 false）；重建仅在 `rebuilt 已闭合(run_closed) && stored 非 null` 时执行（沿用 3b HIGH-1「半套账本不当真理源」+ 本期 MED-2 显式加固）。
2. **无人值守不自动激活**：会改数据的缓存重建默认 OFF；老库 backfill 默认不在开机/不随 Dream 跑（B1）；只读对账随 Dream 默认开（无害、且是证据来源）。
3. **运行证据硬门**：对账绑定 Dream → Dream（cron job）auto 跑落 `cron_executions`，`result` 带对账摘要；诊断出口 `swarmReconcileScan` 可按需拉报告。无 DB 记录的「光有定时器」不算数。

## 对抗审查（独立 reviewer · 对抗心态）
**总体结论：无 HIGH 必修项，可合并。**

- **已修**：MED-2 — 写闸门触发点显式断言 `stored !== null`（把"只对真 drift 重建"不变量从「依赖 reconcileRun 的 note 语义」变成写入点自身可见），加锁定测试。
- **记录（评估后未阻塞）**：
  - MED-1：opt-in `swarmLedgerBackfill` 出口并发 double-trigger 时，`hasLedger` 在事务外 → 第二笔遇 `UNIQUE(run_id,seq)` 冲突回滚、返回 error 而非 skipped。**非数据安全问题**（事务回滚不留脏数据）；属手动 opt-in 出口的极边缘场景。
  - MED-3：`FileSwarmTraceRepository.replaceRunCache` no-op。**当前生产路径不触发**（写闸门关 + 无 File 模式 writer 接入）；接口语义已在代码注释说明。
  - LOW：`swarmReconcileScan` 报告 `generatedAt` 用 `Date.now()`（不写 DB，仅报告时间戳）。

## 样例对账报告（`formatReconcileScanReport` 输出格式）
```
全匹配：
[Swarm 对账@1700000000000] 扫描 12 个 run（limit=200）：匹配 12、偏差 0、跳过 0、错误 0、重建 0

发现偏差（写闸门关，仅报告）：
[Swarm 对账@1700000000000] 扫描 12 个 run（limit=200）：匹配 11、偏差 1、跳过 0、错误 0、重建 0
偏差：
  - run-abc: run/totalToolCalls(ledger=5 rollup=999)
```
> 该报告随 Dream 收尾并入运行报告（落 `cron_executions.result`），亦可经诊断出口 `swarmReconcileScan` 按需拉取。

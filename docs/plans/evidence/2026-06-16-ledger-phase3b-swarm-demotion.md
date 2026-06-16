# 事件账本 第三期(3b) · Swarm 旧表降级 — 交付证据

> 日期: 2026-06-16 · 分支: `feat/event-ledger-phase3b`（基于 main，含 3a）
> 上游: [ADR-023](../../decisions/023-event-spine-read-projection-and-swarm-demotion.md) D2 双写过渡 · [计划](../2026-06-16-event-ledger-phase3b-swarm-demotion.md)
> 验证形式: 确定性测试。用户不读代码，本文用证据说明质量。

## 1. 招牌证据

### ① 影子对账：从 ledger 重建的 rollup == 现存 rollup 表（逐字段）
真实 in-memory DB，经 `SwarmTraceWriter` 跑一个完整 swarm 生命周期（**同时**写 rollup 表 + append-only 协同账本 `swarm_run_ledger`）→ `DatabaseService.reconcileSwarmRun(runId)`：
- **match=true，drift 空**（run 级 totals/status/counts + agent 级 tokens/cost/toolCalls 全字段一致）。
- 反向：人为篡改 `swarm_runs.total_tokens_in=999`（ledger 不动）→ 对账 **drift 精确抓出** `{scope:'run', field:'totalTokensIn', rebuilt:30, stored:999}`。

→ 证明 append-only 账本捕获齐全、可当真理源。

### ② 切换降级：读以 ledger 为真理源、rollup 退为回退缓存
- rollup 表被改坏（total_tokens_in=999、agent tokens_in=999）但 ledger 完整 → `getSwarmRunDetailPreferLedger` 读出 **30（以 ledger 为准），不是被改坏的 999**；timeline events 仍来自 rollup 缓存。
- 无账的历史 run（降级前数据）→ **回退 rollup 缓存读出，不丢**。
- swarm.ipc `getRunDetail` 路由经此（UI 详情以 ledger 为真理源）。

→ 兑现 ADR-022/023"旧表降级为读优化缓存"：rollup 身份从真理源降为读缓存/回退，**写路径一行未改**。

## 2. 验证矩阵

| 步 | typecheck | 单测 | 证据 |
|---|---|---|---|
| 1 表+仓储+契约 | ✅ | `swarmLedgerRepository.test.ts` **5/5**（append/getByRun按seq/listRunIds/多run隔离/append-only） | step1 |
| 2 并行追加(不动写入) | ✅ | `swarmTraceWriter.ledger.test.ts` **3/3**（成套/rollup回归/appendLedger抛错fail-safe）+ writer 8 回归 | step2 |
| 3 rollup 重建投影 | ✅ | `swarmRollupProjection.test.ts` **5/5**（全字段/末值覆盖/parallelPeak峰值/无run_started→null/坏事件跳过） | step3 |
| 4 影子对账+诊断 | ✅ | `swarmReconcile.test.ts` **7/7**（纯对账5+真实管线match=true+篡改drift）+ `diagnostics.swarmReconcile.test.ts` **3/3** | step4（对账证据） |
| 5 切换降级 | ✅ | `swarmDemotion.integration.test.ts` **4/4**（rollup坏以ledger为准/无账回退/HIGH-1半套不盖完整/双缺null） | step5（降级证据） |
| 6 对抗审查+修复 | ✅ | HIGH-1 回归；见 §3 | step6 |

**最终回归**（修复后）：
- 3b 相关 6 文件 **32/32 绿**（ledger仓储+投影+对账+降级+writer并行追加+writer回归）。
- 5 个 swarm/sessionLedger services 文件 **26/26 绿**。
- 全量 agent + ipc **1743/1746 绿**（3 失败为预存在，见 §4）。
- `npm run typecheck` exit 0；eslint 0 error（含 databaseService `max-lines` 硬门：抽 `sessionLedgerSources.ts` 减 god-file 后合规）。

## 3. 对抗审查（独立 context code-reviewer）

对并行追加点 + 重建 + 对账 + 降级回退跑对抗审查，发现并修复：

| 编号 | 等级 | 问题 | 修复 |
|---|---|---|---|
| HIGH-1 | HIGH | `getSwarmRunDetailPreferLedger` 只要 ledger 有 run_started 就当真理源；"运行中崩溃"(有 run_started 无 run_closed，如 closeRun 落盘后 appendLedger 前崩) 会用 status=running 的**不完整重建盖掉 rollup 里已完成的完整数据** | 仅当重建 `status!=='running'`（即含 run_closed）才用 ledger，否则回退 rollup 缓存。加 HIGH-1 回归测试 |
| LOW-1 | LOW | `swarm_run_ledger` 缺 (run_id,seq) 库级唯一约束 | 加 UNIQUE 索引，append-only 不可篡改的库级保护 |
| MED-2 | MED（已具备可见性） | parallelPeak 容忍阈值可能"假绿" | drift 仍**记录**为 `tolerated:true`（在报告里可见，非静默吞掉），暂留小偏差容忍 |

**逐条对账结论**（均已复核）：并行追加真 fail-safe（schedulePersist 内 try/catch，一条失败不断链、不影响 rollup 写入与 swarm 运行）；ledgerSeq per-RunState 单调、多 run 不串号；totals 末值覆盖累加正确；parallelPeak 按 running-count 峰值重算正确；新增方法除 append facade 外全为纯 SELECT；recordedAt 走 event.timestamp（无裸 Date.now()）；现有 startRun/upsertAgent/closeRun/appendEvent 调用逻辑一行未改。

## 4. 边界与已知取舍（非缺陷）

- **写路径零改动**：现有 rollup 写入（startRun/upsertAgent/closeRun/appendEvent）一行未改，ledger append 是旁路新增、fail-safe、fire-and-forget。
- **降级带回退兜底**：无账的历史 run / 半套账本（运行中崩溃）均回退 rollup 缓存，不丢、不读出错误真理源。
- **sessionLedger 协同 lane**：仍读 `swarm_runs`（现为"已被对账验证的读缓存"），与"rollup=读缓存"定位一致。
- **本期不做**：后台定时自动对账（第四期）；自动重建/修复 rollup 缓存。
- **预存在失败（非 3b 引入，已在 origin/main 基线复现）**：`SessionRepository.test`/`agentEngine` 6 测（自建 schema 缺 memory_mode）+ `conversationRuntime`/`messageProcessor.persistence` 3 测。3b 未触碰这些模块。

## 5. 状态
- 7 个 commit（计划 1 + 步骤1/2/3/4/5 各 1 + 对抗审查修复 1）。
- **未 push**（等用户拍板）。

# 事件账本 第三期(3a) · 一本账会话复盘 — 交付证据

> 日期: 2026-06-16 · 分支: `feat/event-ledger-phase3`（基于 phase2 tip）
> 上游: [ADR-023](../../decisions/023-event-spine-read-projection-and-swarm-demotion.md) P2 读侧投影 · [计划](../2026-06-16-event-ledger-phase3-session-replay.md)
> 验证形式: 确定性测试（不依赖真机/网络）。用户不读代码，本文用证据说明质量。

## 1. 招牌证据 — 一本账复盘

跨 6 lane 塞一个真实会话（真实 in-memory SQLite + applySchema + 各 lane 真实写入），
经 `DatabaseService.getSessionLedger(sessionId)` 读回**按时间排序的统一时间线**：

| at | lane | kind | summary | refId |
|----|------|------|---------|-------|
| 100 | message | user | 帮我跑测试 | m1 |
| 200 | task | created | 1: 跑测试 | 1 |
| 300 | swarm | run_started | orchestrator · 2 agents · manual | run-1 |
| 400 | swarm | agent_spawn | spawn a1 | run-1 |
| 450 | decision | allow | Bash: policy allow | 7 |
| 500 | execution | begin | Bash npm test | e1 |
| 550 | execution | complete:success | Bash | e1 |
| 600 | swarm | run_completed | completed · 2✓/0✗ · $0.0123 | run-1 |
| 650 | task | done | 1 | 1 |
| 700 | message | assistant | 好的，开始 | m2 |

**成本汇总（header）**：estimatedCost `$0.0875` · tokensIn `1200` · tokensOut `340`
**laneCounts**：message 2 · task 2 · swarm 3 · decision 1 · execution 2

→ 兑现 ADR-022 第三期目标：**复盘一个会话，从一本账就能按时间看清「对话 + 任务 + 协同 + 成本 + 决策 + 执行」全链路。** 任务事件（session_task_events，已是 append-only）已收编为 task lane；Swarm 以"只读拼入"身份纳入（降级留 3b）。

## 2. 验证矩阵

| 步 | typecheck | 单测 | 证据 |
|---|---|---|---|
| 0 基线 | ✅ | phase1/2 仓储 16 + decisionTrace/ipc 180 全绿 | baseline |
| 1 投影契约+纯合并服务 | ✅ | `sessionLedgerProjection.test.ts` **6/6**（合并/确定性排序/归一化/cost/laneCounts/单lane隔离） | step1 |
| 2 仓储 getBySession+DB拼装 | ✅ | `sessionLedger.integration.test.ts` **真实DB招牌证据**（上表） + 缺lane + fail-safe | step2 |
| 3 诊断出口 | ✅ | `diagnostics.sessionLedger.test.ts` **4/4**（统一时间线/limit截断/缺sessionId/读账fail-safe） | step3 |
| 4 对抗审查+修复 | ✅ | HIGH-1/MED-1 回归新测；见 §3 | step4 |

**最终回归**（修复后）：
- 账本相关 8 文件 **36/36 绿**（phase1/2/3 仓储 + 投影 + 集成 + 3 个 diagnostics）。
- 更广回归 30 文件 **192/192 绿**（toolExecutor decisionTrace/ledger/executionLedger + 全量 ipc）——getBySession 改 ASC 零波及。
- `npm run typecheck` exit 0。

## 3. 对抗审查（独立 context code-reviewer）

对核心合并逻辑 `sessionLedgerProjection.ts` + 新契约 + databaseService 接线 + 诊断出口跑对抗审查，发现并修复：

| 编号 | 等级 | 问题 | 修复 |
|---|---|---|---|
| HIGH-1 | HIGH | `PermissionDecisionRepository.getBySession` 用 DESC，同毫秒多条决策在一本账里逆序（投影按 (at,输入序) 稳定排序，源倒序则同刻逆置）。批量工具执行场景必现 | 改 ASC 对齐 execution lane；仅 ledger facade 消费此方法（grep 确认无其它生产调用方），改序安全 |
| MED-1 | MED | `getSessionLedger` 用 `listRuns(50)` 全局截断 + 内存 filter，某 session 的 swarm run 若不在全局最近 50 内会被**静默漏数据** | 改 `readSwarmRunsForSession` 按 `session_id` 直查 `swarm_runs`（不动 SwarmTraceRepo 接口，守 3a 只读边界） |
| MED-2 | MED | getBySession 默认 limit 50 与 execution lane 的 200 不一致 | 统一 200 |
| LOW | LOW | fail-safe 空账 `generatedAt:0` 无文档 | 出口/契约注释已说明退化空账语义 |

**对抗审查逐条对账结论**（均已复核）：确定性排序算法稳定（`__seq` 单调，无 NaN 逃逸）；单 lane 隔离对"getter抛错/单条map抛错/非数组"三种情况均隔离，无异常逃逸出 `buildSessionLedger`；新增方法全为纯 SELECT，无任何 INSERT/UPDATE/DELETE/ALTER/写文件；`getSessionLedger` 默认参数 `Date.now()` 不在 DB 写操作内（只读投影标记生成时刻），不违时间戳红线。

HIGH-1 回归证据：3 条同毫秒(at=1000)决策 d1→d2→d3 写入 → 账本读回 `['d1','d2','d3']` 正序（修复前会逆序）。
MED-1 回归证据：本 session 1 条 run(startedAt=1) + 他 session 60 条更晚 run 挤满全局最近 50 → 本 session 的 run 仍在账本（按 session 直查无截断）。

## 4. 边界与已知取舍（非缺陷）

- **纯只读边界守住**：本段不新增表、不改 schema、不动任何写路径、不碰 Swarm 写路径。新增仅"只读投影 + 按会话 SELECT + 诊断 case"。
- **Swarm 仍以"只读缓存"身份拼入**：`swarm_runs`/`swarm_run_agents` 仍是可变 rollup，本段只读它、不降级。"让 append-only 事件流当真理源、rollup 降级为派生缓存"是 3b（ADR-023 D2 双写过渡），不在本段硬门内。
- **预存在失败（与 phase3 无关）**：`SessionRepository.test.ts`(1) + `SessionRepository.agentEngine.test.ts`(5) 在 **phase2 基线上同样失败**（`table sessions has no column named memory_mode`，自建 schema 陈旧），phase3 未触碰 SessionRepository，非本期引入。

## 5. 状态

- 6 个 commit（计划文档 1 + 步骤1/2/3 各 1 + 对抗审查修复 1）。
- **未 push**（遵守不主动 push 边界，等用户拍板）。

# 事件账本 第三期(3a) · 一本账会话复盘（实施计划）

> 日期: 2026-06-16 · 作者: Neo · 状态: 待执行（等用户拍板 ADR-023）
> 上游决策: [ADR-022](../decisions/022-append-only-event-ledger-spine.md) §四第三期 + [ADR-023](../decisions/023-event-spine-read-projection-and-swarm-demotion.md) 决策点 1 = P2（读侧投影）
> 分支: `feat/event-ledger-phase3`（基于 `feat/event-ledger-phase2` tip，含一/二期账本）
> 前提: 用户不读代码、不做 review。质量由每步可执行验证闸门保证，验证不过不进下一步。

## 1. 目标与边界

**目标**：兑现 ADR-022 第三期招牌证据——**复盘一个真实会话时，从"一本账"就能按时间看清「对话 + 任务 + 协同 + 成本 + 决策 + 执行」全链路**。落地形态按 ADR-023 P2：**只读逻辑投影**，把已有的各 append-only 小账本 + 成本，按时间合并成统一时间线读出，**不建物理大表、不动任何写路径、不改 schema**。

**本段（3a）做什么**：
- 把**任务事件 `session_task_events`**（已是 append-only 表，todoWrite 在写）正式**收编**进统一读出面。
- 新增**只读投影服务** `SessionLedgerProjection`：给定 sessionId，合并 6 条 lane（message/task/swarm/decision/execution/cost）→ 按时间排序的 `SessionLedger`。
- 新增**诊断读出口** `case 'sessionLedger'`，作为可演示的交付证据出口（照一/二期 `decisions`/`recovery` 模式）。

**纯只读边界（明确不做）**：
- **不新增表、不改 schema、不动任何写路径**（messages/telemetry/swarm/task/permission_decisions/tool_execution_events 全不碰写入）。
- **不碰 Swarm 写路径**：Swarm 以"只读拼入"身份纳入一本账（ADR-023 决策点 2 的降级是 3b，本段按 D3 只读）。
- 各账本仓储仅**新增按会话查询的 SELECT 方法**（append-only 不变量不破：无 UPDATE/DELETE）。
- 不做"旧表降级 / 双写过渡"（3b）、不做后台对账（第四期）。
- 投影全程 **fail-safe 且按 lane 隔离**：任一 lane 读失败只让该 lane 为空，不拖垮整本账，更不影响任何业务路径。

## 2. 现状锚点（file:line）

```
诊断读出口模式:      src/main/ipc/diagnostics.ipc.ts:40/89        case 'decisions'/'recovery'（照此加 'sessionLedger'）
DB 网关/facade:      src/main/services/core/databaseService.ts    各 repo + fail-safe facade（appendPermissionDecision 等）
对话 lane:           databaseService.getMessages(sessionId,...)   :613 → SessionRepository.getMessages :522
任务 lane（收编对象）: databaseService.getSessionTaskEvents()       :681 → SessionRepository.getSessionTaskEvents :1189（append-only 已就绪）
协同 lane:           databaseService.getSwarmTraceRepo()          :990 → SwarmTraceRepo.listRuns :192 / getRunDetail :226（listRuns 项带 sessionId :209）
决策 lane:           PermissionDecisionRepository.getBySession()  已存在（:96 区）；facade 需补 getPermissionDecisionsBySession
执行 lane:           ToolExecutionEventRepository                 需补 getBySession（仅 SELECT）；facade 需补 getToolExecutionsBySession
成本维度:            telemetry_sessions.estimated_cost            schema.ts:456；经 telemetryQueryService 读出
任务事件契约:        src/shared/contract/planning.ts:62-85         SessionTaskEventKind(12 种) + SessionTaskEvent
append 仓储先例:     repositories/PermissionDecisionRepository.ts / ToolExecutionEventRepository.ts  只 INSERT/SELECT
repo 单测模板:       tests/unit/services/toolExecutionEventRepository.test.ts  in-memory better-sqlite3 + applySchema
```

## 3. 分步实现（每步先写失败测试后实现，独立 commit）

### 步骤 0 — 基线
`npm run typecheck` + 跑 `permissionDecisionRepository.test.ts` / `toolExecutionEventRepository.test.ts` / `toolExecutor.decisionTrace.test.ts` / `diagnostics.*.test.ts` 留绿底。

### 步骤 1 — 投影契约 + 纯合并服务（不接 DB，可独立测）
- 新增 `src/shared/contract/sessionLedger.ts`：
  - `LedgerLane = 'message' | 'task' | 'swarm' | 'decision' | 'execution'`（成本走 header 汇总，不入 lane 流）。
  - `LedgerEntry { at: number; lane: LedgerLane; kind: string; summary: string; refId?: string; detail?: Record<string, unknown> }`。
  - `SessionLedgerCost { estimatedCost: number; tokensIn: number; tokensOut: number }`。
  - `SessionLedger { sessionId: string; generatedAt: number; entries: LedgerEntry[]; cost: SessionLedgerCost; laneCounts: Record<LedgerLane, number> }`。
- 新增 `src/main/services/core/sessionLedgerProjection.ts`：纯函数 `buildSessionLedger(sources, generatedAt)`，入参是**已读出的各 lane 原始数据**（依赖注入，不在此读 DB），职责仅**归一化 → 合并 → 按 `at` 稳定排序 → 统计 laneCounts**。每个 lane 的归一化包在独立 try/catch，单 lane 抛错记空、不影响整体。
- **验证**：typecheck；`tests/unit/services/sessionLedgerProjection.test.ts`（纯内存假数据）：
  - 6 路输入合并后按 `at` 升序、稳定排序（同 `at` 保持 lane 输入序）；
  - 每条 entry 的 lane/kind/summary/refId 归一化正确（任务事件 12 种 kind 透传；swarm run 映射为 swarm lane；decision/execution 映射）；
  - cost 汇总正确；laneCounts 计数正确；
  - **按 lane 隔离 fail-safe**：构造某 lane 输入为抛错的 getter → 该 lane 计 0、其余 lane 完整（招牌健壮性断言）。

### 步骤 2 — 仓储补按会话 SELECT + databaseService 拼装真实读出
- `ToolExecutionEventRepository.ts`：新增 `getBySession(sessionId, limit?)`（**仅 SELECT**，append-only 不变量不破）。`PermissionDecisionRepository.getBySession` 已存在，直接用。
- `databaseService.ts`：新增 fail-safe facade `getSessionLedger(sessionId)`——按序读 6 lane（getMessages / getSessionTaskEvents / swarm listRuns+getRunDetail by session / getPermissionDecisionsBySession / getToolExecutionsBySession / 成本 estimated_cost），喂给 `buildSessionLedger`。整段 try/catch + 单 lane 读取各自 fail-safe（照 `appendPermissionDecision`/`getOpenToolExecutions` 既有风格），DB 不可用返回空 ledger 而非抛。补 `getPermissionDecisionsBySession` / `getToolExecutionsBySession` 两个 facade getter。
- **验证**：typecheck；`tests/unit/services/sessionLedger.integration.test.ts`（**真实 in-memory DB + applySchema**，照 repo 单测模板）：
  - 给一个 session 跨表塞数据（几条 message + 几条 task event + 一个 swarm run + 几条 decision + 一对 begin/complete execution + estimated_cost）→ `getSessionLedger` 读回**一本账**：6 lane 都在、按时间排序、cost 汇总对得上 = **招牌证据（确定性形式）**；
  - 某表为空时该 lane 缺席、其余正常；
  - DB facade 在 repo 不可用时返回空 ledger 不抛（fail-safe 回归）。

### 步骤 3 — 诊断出口（交付证据出口）
- `diagnostics.ipc.ts` 新增 `case 'sessionLedger'`：从 `request` 取 `sessionId`，调 `getDatabase().getSessionLedger(sessionId)`，返回 `{ sessionId, generatedAt, cost, laneCounts, entries }`（entries 可按 limit 截断）。fail-safe：读失败返回空 ledger 结构，不影响出口。
- **验证**：typecheck；`tests/unit/ipc/diagnostics.sessionLedger.test.ts`：DB 塞一个跨 6 lane 的会话 → 经诊断出口读回统一时间线（对话+任务+协同+成本+决策+执行齐全、时序正确）= **ADR 第三期交付证据**。

### 步骤 4 — 对抗审查 + 证据归档（高风险点把关）
- **对抗审查**（动了共享类型契约 + 核心合并逻辑，按用户铁律走）：对 `sessionLedgerProjection.ts` 的合并/排序/fail-safe 隔离逻辑 + `sessionLedger.ts` 契约跑一轮 `codex-audit` 或 `/multi-review`，重点查：稳定排序边界、单 lane 隔离是否真隔离、空/缺失 lane 处理、时间戳来源一致性（禁裸 Date.now()，generatedAt 走参数）。发现问题 TDD 修。
- 证据归档 `docs/plans/evidence/2026-06-16-ledger-phase3-*`（baseline/step1/2/3 测试输出 + 招牌"一本账"读回截图式文本 + 对抗审查结论）。

## 4. 验证汇总

| 步 | typecheck | 单测 | 回归 | 证据 |
|---|---|---|---|---|
| 0 | ✅ | — | phase1/2 repo + decisionTrace + diagnostics | baseline log |
| 1 | ✅ | 合并/排序/归一化/cost/laneCounts/单lane隔离 | — | step1 log |
| 2 | ✅ | 真实DB一本账读回（招牌）+ 缺lane + fail-safe | phase1/2 repo 回归 | step2 log（招牌证据） |
| 3 | ✅ | 诊断出口读回统一时间线 | diagnostics 回归 | step3 log（交付证据） |
| 4 | ✅ | （对抗审查发现项的回归测试） | 全量 services/ipc 回归 | 对抗审查结论 + 归档 |

证据归档 `docs/plans/evidence/2026-06-16-ledger-phase3-*`。

## 5. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 投影读取拖垮业务/复盘出错 | 纯只读、与所有写路径解耦；单 lane try/catch 隔离；DB 不可用返回空 ledger | 各步独立 commit，revert 投影/出口即回到一/二期状态，零残留 |
| 误碰写路径或 schema | 边界硬约束：本段只新增「只读投影 + SELECT 方法 + 诊断 case」，不出现任何 INSERT/UPDATE/DELETE/ALTER/CREATE | step0 schema 回归 + diff 自审（无写操作） |
| append-only 被破坏 | 新增的 `getBySession` 仅 SELECT；单测断言仓储不暴露 update/delete | revert 该方法 |
| 共享契约改动引入隐性破坏 | 新契约为纯新增（不改 SessionTaskEvent 等既有契约）；步骤 4 对抗审查把关 | revert contract 文件 |
| 时间戳裸 Date.now() 违规 | `generatedAt` 走参数传入；投影内不写 DB、无 recorded_at | — |
| Swarm rollup 可变导致复盘不严谨 | 本段已知取舍：Swarm 以"只读缓存"身份拼入，严谨化（降级为派生缓存）留 3b（ADR-023 D2） | — |

## 6. 与后续段的衔接

- **3b**（Swarm 降级，ADR-023 D2）：本段的 `SessionLedgerProjection` 已为 swarm lane 留好接口，3b 把 swarm lane 的数据源从"可变 rollup"切到"append-only 事件流"时，投影读出面无需重写——只换 lane 的数据来源。
- **第四期**（后台对账 + 老库迁移）：本投影可直接复用为"对账"的读出基准。

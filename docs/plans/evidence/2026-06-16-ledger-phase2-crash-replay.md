# 事件账本 第二期 · 崩溃重放 — 交付证据

> 日期: 2026-06-16 · 分支: feat/event-ledger-phase2 · 上游: ADR-022 §四 第二期
> 验证方式: TDD（每步先看红再转绿）。用户不读代码，本文档=可演示的质量证据。

## 一、ADR 第二期目标达成对照

| ADR §四 第二期要求 | 本期交付 | 证据 |
|---|---|---|
| 崩溃重启后从总账把"崩溃前正在做的事"**重放回来** | 工具执行生命周期 begin/complete 事件入账本，未闭合执行=在飞工序，重启时重建出**工具名+完整参数+session+已跑耗时** | crashRecovery 测试「强杀→重启→现场被完整恢复」 |
| 而不只是打个"已中断"标记 | 保留原 markCrashedActiveSessions 中断标记，**之上**新增现场重建，二者叠加 | databaseService 初始化先标记后重建快照 |
| 演示"运行中强杀进程 → 重启 → 现场被完整恢复" | 真实文件 DB：appendBegin→close(模拟 SIGKILL，无 complete)→重开同一 DB(模拟重启)→重放出精确参数 | 见下「招牌证据」 |

## 二、招牌证据：强杀 → 重启 → 现场恢复（确定性形式）

`tests/unit/services/crashRecovery.test.ts` 用**真实文件 SQLite**模拟整条崩溃-重启链路：

1. **运行中**：工具 `Bash`（`pnpm run migrate`，cwd=`/repo`，timeout=600000）放行后落 `begin`（t=42000）。
2. **SIGKILL**：进程在执行中途死亡——直接 `db.close()`，**绝不落 complete、无优雅退出**。
3. **重启**：重新打开同一 DB 文件 + 幂等 applySchema，`buildRecoverySnapshot(now=50000)` 重建出：
   - `totalInFlight=1`，归属 `live-session`
   - 工具 `Bash` + **完整参数** `{command:'pnpm run migrate', cwd:'/repo', timeout:600000}`
   - `startedAt=42000`，`elapsedMs=8000`（崩溃前已跑 8 秒）
4. **确认恢复**：`acknowledgeRecovery` append 一条 `complete{status:'recovered'}` 闭合现场。
5. **二次重启**：`totalInFlight=0`——已恢复不重复浮现（幂等）。

→ 这就是"运行中强杀 → 重启 → 现场被完整恢复"的确定性可重跑版本，比起旧的"只把 running 翻成 interrupted"，现在能拿回**具体在执行什么工具、参数是什么、跑了多久**。

## 三、全部用例（19/19 通过）

```
■ tool_execution_events 仓储（append-only 生命周期）         7/7
   ✓ schema 建出表与索引
   ✓ appendBegin → getOpenExecutions 取回，params round-trip
   ✓ append complete 后该执行不再 open（闭合）
   ✓ 多 execution 并存，只浮现未闭合的
   ✓ complete 携带 error 可读回 status/error
   ✓ count 递增
   ✓ append-only 不变量：无 update/delete 方法

■ 崩溃恢复服务 crashRecovery                                 4/4
   ✓ 未闭合执行 → 快照按 session 分组、参数完整重建
   ✓ 已闭合执行不进快照；无在飞时 totalInFlight=0
   ✓ 强杀进程 → 重启 → 现场被完整恢复（真实文件 DB 重放）  ← 招牌
   ✓ acknowledgeRecovery 每条在飞 append recovered 闭合

■ toolExecutor 接入（执行生命周期落库 · 热路径）            5/5
   ✓ 放行执行 → 成对 begin+complete，execution_id 一致，status=success
   ✓ begin 先于 complete（崩溃在执行中途才留未闭合 begin）
   ✓ 工具抛异常 → 仍落 complete，status=error 带 error
   ✓ 工具返回 success=false → complete.status=error
   ✓ DB 不可用 → 工具执行不受影响（fail-safe）

■ diagnostics IPC recovery 出口（交付证据通道）             3/3
   ✓ 返回 totalInFlight + 按 session 的在飞工具+参数
   ✓ 无崩溃现场 → totalInFlight=0、sessions 空
   ✓ 账本读取抛错 fail-safe：仍返回成功
```

## 四、分层验证汇总

| 闸门 | 结果 |
|---|---|
| `npm run typecheck` | ✅ No errors found（每步后跑） |
| phase2 新增单测 | ✅ 19/19 |
| 全量 toolExecutor 回归（热路径接线安全性） | ✅ 1863/1863，零回归 |
| phase1 账本回归（permissionDecisionRepo + decisions IPC + ledger 接入） | ✅ 全绿 |
| DB schema/service 回归 | ✅ 全绿 |
| 仓储层裸 `Date.now()` 自检 | ✅ 新增仓储/服务时间戳全走参数 |
| append-only 不变量自检 | ✅ 新表无 UPDATE/DELETE 语句与方法 |

## 五、纯增量边界守住

- 只**新增** `tool_execution_events` 一张表（`CREATE TABLE IF NOT EXISTS`），不动 messages/telemetry/swarm/task/permission_decisions/sessions。
- 不改权限判定逻辑、不改工具执行结果；begin/complete 全程 try/catch fail-safe，DB 任何问题不阻断执行（已被「DB 不可用」用例锁定）。
- 保留 `markCrashedActiveSessions` 原中断标记行为，崩溃重建是其增强而非替换。
- 无新增 ADR 决策点。

## 六、本期边界（明确未做，留后续）

- 不做"自动续跑 agent loop"——交付到"重建出可被消费的恢复现场快照 + 经诊断出口读回"为止；把快照真正喂回 agent 续跑是后续接线工作。
- 不迁移其它账本（第三期）、不做后台对账（第四期）。

## 七、提交序列

```
feat(ledger): 第二期 执行生命周期表+仓储（append-only begin/complete）
feat(ledger): 第二期 崩溃恢复服务（从总账重建在飞现场）
feat(ledger): 第二期 接入工具执行生命周期 + databaseService 暴露
feat(ledger): 第二期 诊断 recovery 出口暴露崩溃现场快照（交付证据）
```

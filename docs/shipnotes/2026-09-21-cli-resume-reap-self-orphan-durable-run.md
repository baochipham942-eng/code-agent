# Ship note · 2026-09-21 · CLI -s 续跑收尸自拍僵尸 durable run（Fixes #1993）

## 根因

前一轮 CLI 异常结束（超时/被外层杀掉）后，残留活跃 durable run 没收尾。新一轮 `neo run -s <session>` 的启动恢复（recoverDurable / 清扫器）会把这条 run 的过期租约认领到**本进程**名下，但不绑定任何 handle。续跑创建新根 run 撞活跃会话唯一索引后，`cancelOrphanedSessionRoot` 的跨进程僵尸判据（owner pid 探测 / 租约过期）因为 owner 已经是本进程而必然拒收——续跑没有任何恢复路径，直接 `{"success":false,"error":"Session <id> already has an active durable run"}` 退出。夜跑 2026-09-20 fl-mail-to-deck 第 2 轮即死于此。

## 修法

`RunRegistry.cancelOrphanedSessionRoot` 在跨进程判据之前新增自拍收尸：会话活跃主 run 的 owner 是本进程实例、且注册表里没有任何活 handle 在驱动它（恢复认领后无人领养 = 僵尸），沿 `terminalDurable` 规范路径（owner/attempt fence + 事件序号）终态化成 `cancelled`（reason `cli_resume_reaped_recovered_orphan`）并记结构化 warn 日志，随后正常续跑。

不放宽的边界：有 handle 的真活 run（本进程正在跑）与其它进程持有有效租约的 run 保持原冲突语义，绝不并发双跑（数据竞争）。

## 反向变异

把 `runRegistry.ts` 的自拍收尸调用短路成 `if (false && ...)` 后：

```
 FAIL  tests/unit/host/runtime/durableOrphanSessionRootReap.test.ts > cancelOrphanedSessionRoot zombie reaping > reaps a self-owned recovered run with no live handle and lets the resume start a new run
AssertionError: expected false to be true // Object.is equality
```

恢复后 4/4 绿。

## 测试

新增 `tests/unit/host/runtime/durableOrphanSessionRootReap.test.ts`（Vitest 4，4 例）：

1. 跨进程僵尸（owner pid 已死、租约未过期）→ 收尸成功，续跑起新 run。
2. 自拍僵尸（recoverDurable 认领、无 handle）→ 收尸成功，终态 reason/事件/注册表清理逐项断言，续跑起新 run。
3. 本进程真活 run（有 handle）→ 拒收，`startDurable` 仍抛 `RunSessionConflictError`。
4. 跨进程活 run（活 pid + 有效租约）→ 拒收。

存量回归：`tests/unit/host/runtime/` 全目录 25 文件 205 例 + `tests/unit/cli/bootstrap.durableRun.test.ts` + `tests/unit/cli/adapter.cliAgent.test.ts` 全绿；`npm run typecheck` 绿；`npm run gates:fast -- --regressions <json>` 绿（receipt 见 PR）。

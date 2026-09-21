# Ship note · 2026-09-21 · CLI -s 续跑收尸自拍僵尸 durable run（Fixes #1993）

## 根因

前一轮 CLI 异常结束（超时/被外层杀掉）后，残留活跃 durable run 没收尾。新一轮 `neo run -s <session>` 的启动恢复（recoverDurable / 清扫器）会把这条 run 的过期租约认领到**本进程**名下，但不绑定任何 handle。续跑创建新根 run 撞活跃会话唯一索引后，`cancelOrphanedSessionRoot` 的跨进程僵尸判据（owner pid 探测 / 租约过期）因为 owner 已经是本进程而必然拒收——续跑没有任何恢复路径，直接 `{"success":false,"error":"Session <id> already has an active durable run"}` 退出。夜跑 2026-09-20 fl-mail-to-deck 第 2 轮即死于此。

## 修法

`RunRegistry.cancelOrphanedSessionRoot` 在跨进程判据之前新增自拍收尸：会话活跃主 run 的 owner 是本进程实例、且注册表里没有任何活 handle 在驱动它（恢复认领后无人领养 = 僵尸），沿 `terminalDurable` 规范路径（owner/attempt fence + 事件序号）终态化成 `cancelled`（reason `cli_resume_reaped_recovered_orphan`）并记结构化 warn 日志，随后正常续跑。

不放宽的边界：有 handle 的真活 run（本进程正在跑）与其它进程持有有效租约的 run 保持原冲突语义，绝不并发双跑（数据竞争）。`waiting` / `paused` 状态有明确业务语义（待人工复核 / 待审批，ai-review R1 指出误收尸会吃掉挂起审批），归桌面复核收件箱与显式取消路径（`terminalRecoveredWaitingRun`）管，CLI 续跑不替人做决定。只收 `native` 引擎：loop / agent_team 等引擎的 recovery driver（`LoopController.adopt`、各自账本）不注册 RunHandle 却仍在驱动 run，「无 handle」对它们不等于「无驱动」（ai-review R2）。

## 反向变异

把 `runRegistry.ts` 的自拍收尸调用短路成 `if (false && ...)` 后：

```
 FAIL  tests/unit/host/runtime/durableOrphanSessionRootReap.test.ts > cancelOrphanedSessionRoot zombie reaping > reaps a self-owned recovered run with no live handle and lets the resume start a new run
AssertionError: expected false to be true // Object.is equality
```

恢复后 4/4 绿。

## 测试

新增 `tests/unit/host/runtime/durableOrphanSessionRootReap.test.ts`（Vitest 4，6 例）：

1. 跨进程僵尸（owner pid 已死、租约未过期）→ 收尸成功，续跑起新 run。
2. 自拍僵尸（recoverDurable 认领、无 handle、recovering）→ 收尸成功，终态 reason/事件/注册表清理逐项断言，续跑起新 run。
3. 恢复后停在 waiting 的 run（待人工复核）→ 拒收，续跑仍抛冲突（ai-review R1 收口）。
4. loop 引擎的自拍 run（recovery driver 驱动、无 handle）→ 拒收（ai-review R2 收口）。
5. 本进程真活 run（有 handle）→ 拒收，`startDurable` 仍抛 `RunSessionConflictError`。
6. 跨进程活 run（活 pid + 有效租约）→ 拒收。

存量回归：`tests/unit/host/runtime/` 全目录 25 文件 205 例 + `tests/unit/cli/bootstrap.durableRun.test.ts` + `tests/unit/cli/adapter.cliAgent.test.ts` 全绿；`npm run typecheck` 绿；`npm run gates:fast -- --regressions <json>` 绿（receipt 见 PR）。


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=8d1a2cc2e257069b49ceebade3e7395ea58c6088 base=a5ca056be0b1803312259441b9837698368ad8ea receipt=cf9ad9c7-ff71-435e-a40f-80b006823bf9 runner=remote


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=1cfb44c619b9d3c61a1e9f748c83882f24fb975d base=a5ca056be0b1803312259441b9837698368ad8ea receipt=9adb4435-1e8b-4c94-b25d-61b05a26b083 runner=remote


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=5fcc1fc1605f20a196a5a13e9765efd40d60164d base=7f353a4fec5d2526531dbbf93c5f086fec8ad664 receipt=9aea43e3-afaa-4932-a53c-a164e2598ae7

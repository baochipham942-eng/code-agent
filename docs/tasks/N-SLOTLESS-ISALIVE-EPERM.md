# N-SLOTLESS-ISALIVE-EPERM

Main Full Gate run 37183654037 红 1 条：`verifySlotless.test.ts > --stop derives late app launches...` → `Error: kill EPERM`。

根因：测试 PATH 上的假 pgrep 输出 4343，默认 residualRuntime 对其调 `isAlive(4343)`=`process.kill(4343,0)`；CI 上该 pid 若是他人用户的活进程则抛 EPERM，isAlive 只认 ESRCH，其余 throw。取决于 CI 上哪个 pid 存在，故 flaky。

修复：`scripts/verify-slotless.mjs` 的 `isAlive` 把 EPERM 视为存活（进程存在）。调用方均安全：stopProcessGroup 后续校验 ps marker 不匹配即拒绝；findOwnedResidualProcesses 随后按命令行过滤掉非本 run 进程。

回归测试：`isAlive treats EPERM ... as alive`（pid 1 非 root 下 EPERM）。

## 反向变异

变异：删掉 `isAlive` 里 `if (error?.code === 'EPERM') return true;`。

```
 × isAlive treats EPERM (live process owned by another user) as alive, ESRCH as dead
 FAIL  tests/scripts/verifySlotless.test.ts > slotless verification scripts > isAlive treats EPERM ...
Error: kill EPERM
 Tests  1 failed | 18 passed (19)
```

还原后：`Tests 19 passed (19)`。


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=bbf827157cebffe05cff74a66fb21453f086a53a base=226d03e6461c93c02136df1b5b0717fae4ea40b3 receipt=6a0fd759-9cf6-4822-94ec-d65ff30f8838

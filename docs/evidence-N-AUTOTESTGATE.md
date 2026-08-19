# N-AUTOTESTGATE 验收证据

- 日期：2026-08-19
- 分支：`fix/autotest-permission-gate`
- 代码提交：`8906eee9a`

## 前提查证：测试环境是否默认开启 AUTO_TEST

结论：仓库测试环境不默认开启 `AUTO_TEST`，`permissionResponseDelivery.test.ts` 原注释已过时，未发现需要扩大工单范围的批量假绿前提。

证据：

- 当前启动环境中 `AUTO_TEST` 未设置。
- 定向检索 `vitest.config.ts`、`tests/setup.ts`、`tests/globalSetup.ts`、`package.json` 和隐藏 `.env*`，没有 `AUTO_TEST` 默认赋值。
- 仓内精确检索只发现生产判据、测试用例的显式 `stubEnv`/赋值，以及 `AUTO_TEST_*` 其他变量；没有测试启动入口注入。
- 通过 Node `--import` 探针启动真实 Vitest 子进程，输出 `AUTOTEST_PROBE=undefined`；同次 `permissionResponseDelivery.test.ts` 为 9 passed / 0 failed / 0 skipped。
- 已把原注释改为“仓库测试环境不默认设置；显式清空用于隔离调用方 shell 遗留变量”。

## 收口行为

- 注入的 permission handler 优先裁决，`AUTO_TEST` 无法覆盖显式策略。
- 仅 `AUTO_TEST === 'true'` 且没有注入处理器时保留原有兜底放行。
- `AUTO_TEST=false` 不进入兜底；目录扩权在停车仓库不可用时按既有 fail-closed 路径拒绝。
- 未设置 `AUTO_TEST` 的常规审批、devModeAutoApprove 和停车行为保持原路径，既有断言未删除或反转。

## 定向测试与反向变异

绿态：

```text
tests/unit/permissions/parkingBeforeAutoApprove.test.ts
tests/unit/web/permissionResponseDelivery.test.ts
Test Files 2 passed (2)
Tests 18 passed (18)
```

反向变异把源码临时恢复为原始形态：truthy `AUTO_TEST` 无条件放行，并放在注入处理器之前。结果按预期转红：

```text
Test Files 1 failed (1)
Tests 2 failed | 7 passed (9)
失败用例：
1. 显式审批处理器优先于 AUTO_TEST=true 兜底
2. AUTO_TEST=false 不放行目录扩权请求
```

变异后已还原源码，重新跑定向套件为 18 passed / 0 failed / 0 skipped。

## 全量测试计数

命令：`npm test`

```text
Test Files 1 failed | 2364 passed | 4 skipped (2369)
Tests 1 failed | 20434 passed | 7 skipped | 29 todo (20471)
Duration 663.70s
```

唯一失败：`tests/agent/agentOrchestrator.test.ts` 的“真实语音入口链”用例在 30 秒超时；同一现场先报临时目录下 `typescript-language-server ENOENT`。该用例隔离复跑结果为 1 passed / 0 failed，另有 56 个同文件用例因 `-t` 过滤而 skipped，实际测试耗时 313ms。全量结果按失败入账，不宣称全量全绿；隔离复跑没有复现稳定回归。

## 静态门预检

- `npm run typecheck`：通过，0 错误。
- `node scripts/eslint-ratchet.mjs`：通过；errors 0/0，warnings 414/414，delta 0。
- `node scripts/tsc-tests-ratchet.mjs`：通过；current 0，baseline 0，delta 0。
- `node scripts/knip-ratchet.mjs`：通过；当前 2620，基线 2632，未新增。
- `node scripts/knip-ratchet.mjs --profile production`：通过；dead exports 当前 3864，基线 3904；生产不可达文件当前 125，基线 130，均未新增。

交付前在证据档提交完成后，按工单要求重新运行同一组门，最终运行结果以交接消息为准。

## 证据档位

`static-contract`（typecheck、eslint ratchet、tests TypeScript ratchet、knip 默认与 production profile）+ `hermetic-protocol`（权限岛真实方法级单测与 Web 审批投递单测）+ `fault-injection`（恢复 AUTO_TEST 无条件放行后两条安全用例转红，再还原复验）。未做 `real-runtime` 真机 dogfood。


## 🔴 收活后监工改动：删掉没接电的注入口（2026-08-19）

工人实现里同时加了 `injectedPermissionHandler` 注入口（排在 AUTO_TEST 之前）。
监工用 `rtk proxy grep` 复核：**7 处命中全在 `orchestratorPermissions.ts` 自身 + 1 处测试，
生产零消费方** ⇒「注入优先」这条逻辑在生产里永远不执行，属于「装好了没接电」。

产品负责人拍板删掉。已删：
- `src/host/agent/orchestratorPermissions.ts` 的字段/构造参数/类型声明/优先分支（4 处）
- `tests/unit/permissions/parkingBeforeAutoApprove.test.ts` 中依赖它的用例
  「显式审批处理器优先于 AUTO_TEST=true 兜底」

⇒ **本单真实生效的收口只有一条：判据由 `process.env.AUTO_TEST`（truthy）收窄为 `=== 'true'`**，
与 `autoTestHook.ts:22` 同源。保留的两条断言仍钉死行为：
「没有显式处理器时保留 AUTO_TEST=true 兜底放行」「AUTO_TEST=false 不放行（fail-closed）」。

为什么不留着备用：与 PR#1250 的 `forcePermissionHandler` 不同（那个有真实生产消费方——eval 链路），
这个没有。今天一整天在治的正是「看起来有门、实际没有路径经过它」，不该自己再造一个。
等真有单需要给 agentOrchestrator / web 前台注入 run 级审批策略时再加，那时才知道接口该长什么样。

删后重跑门（**门的有效期只到下一次改动为止**）：
- 定向测试 `parkingBeforeAutoApprove` + `permissionResponseDelivery`：**17 passed / 0 failed**
- `npm run typecheck`：通过
- `tsc-tests-ratchet`：current=0 / baseline=0
- `eslint-ratchet`：warnings 414/414 持平
- `knip-ratchet` 默认档与 `--profile production`：均未新增
- `check-design-system`：通过

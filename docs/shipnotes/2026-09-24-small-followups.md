# Small follow-ups: plugin notification, trace retention, workspace details

本次收尾覆盖 4 张小单：

- 关闭并回写已修复的问题卡 #1603、#2013、#2012；#1603 的主干 Full Gate 已在 `82fbfbbdf` 通过。
- 插件通知接入统一通知策略、聚焦行为和 `NOTIFICATION_SHOW` 事件，不再停留在 TODO 日志。
- 启动期日志保留接入 `~/.code-agent/traces` 的 trace ledger 清理，并返回 `traceDeleted` 统计。
- 工作区详情抽屉接入目录、Git 状态和近期会话摘要，补齐中英文文案与 IPC 协议。

## 反向变异

变异：移除 `runLogRetention()` 对 trace ledger 的 `cleanupDirByMtime()` 调用；验证结果：

```
FAIL tests/unit/services/infra/logRetention.test.ts > runLogRetention > 清理 trace ledger 的过期文件，并保留近期 trace
AssertionError: expected +0 to be 1
Tests 1 failed | 6 passed (7)
```

变异已还原，focused tests 全绿。

## 验证

- focused Vitest：6 个测试文件、173 tests passed；补丁后的 retention/workspace focused run：2 个文件、24 tests passed。
- `npm run typecheck` passed。
- `node scripts/check-copy.mjs` passed（1054 files，pressure/ellipsis baseline 0）。
- `git diff --check` passed。
- 基线 main Full Gate run `35969161063` passed（typecheck、full Vitest、coverage ratchet）；本分支随后以 clean committed HEAD 重跑 `gates:fast`。
- `npm run gates:fast -- --regressions <json>` 已通过 clean HEAD、provider/private、typecheck、shell、commit-checks、selected Vitest、package typechecks 和 tests typecheck；`ship pr` 会在最终 push 前对 HEAD 再做一次 fresh receipt 复核。

证据档位：static-contract（typecheck/check-copy）+ hermetic-protocol（focused Vitest）+ fault-injection（反向变异）；未做 real-runtime / 真机验收。

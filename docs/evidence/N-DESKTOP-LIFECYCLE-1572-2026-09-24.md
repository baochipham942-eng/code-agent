# N-DESKTOP-LIFECYCLE-1572 · 2026-09-24

## 问题

`desktop-lifecycle` nightly 在 macOS 15 与 Windows 同时失败。14 个 durable run 重启场景中，未知写副作用被 native recovery 以 `tool-result:interrupted` 收成 completed；MCP 可查询任务在连接租约接口未接入验收 fake client 时，在真正 query 前被吞成 `task query transport is unavailable`。

## 修复

- 未知写副作用不再调用 interrupt 或提交 completed，恢复为 `waiting` 并返回 `requires_review: unknown_write_side_effect`。
- durable lifecycle 的 MCP fake client 补齐连接租约接口，使恢复路径实际执行既有 task query/result 合同。

## 反向变异

- 将未知写分支改回“interrupt 后 completed”时，`between-tool-begin-end-unknown-write` 必须变红：期望 `waiting`、无 terminal commit。
- 移除 fake client 的 `acquireConnectionLease` / `releaseConnectionLease` 时，`mcp-durable-task-queryable` 必须变红：provider query 计数回到 0，场景不能通过。

实际反向变异输出：

```text
FAIL tests/unit/host/runtime/nativeRecoveryHost.test.ts > NativeRecoveryHost production recovery > keeps unknown writes in review without replaying the tool
AssertionError: expected { status: 'recovered', … } to match object { status: 'requires_review', … }
```

```text
{"pass":false,"scenarios":14,"gates":{"allKillPointsPassed":false,...}}
exit 1
```

## 验证

- `npx vitest run tests/unit/host/runtime/nativeRecoveryHost.test.ts tests/unit/host/runtime/durableNativeRecoveryLifecycle.test.ts`：44 passed。
- `CODE_AGENT_DATA_DIR=/tmp/neo1572-acceptance-data npx tsx scripts/acceptance/durable-run-kill-restart.ts --out /tmp/neo1572-acceptance.json`：14 scenarios，9 gates 全部通过。
- `NEO_EVAL_ANSWERS_DIR=.../code-agent-private-archive/eval CODE_AGENT_DATA_DIR=/tmp/neo1572-data npm run gates:fast -- --regressions /tmp/neo-1572-regressions.json`：通过，receipt `409e6317-66d3-4976-9593-753292d71a40`。

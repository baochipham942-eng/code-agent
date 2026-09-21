# N-SQLITE-WAL-BUSY-TIMEOUT — 并发写 database is locked 修复证据档

工单：GitHub issue #1992（夜跑 2026-09-20，8 个 CLI 会话并发同库：`database is locked`
17 次/15 会话；`[SessionManager] Failed to persist message` 消息丢失、
`[TelemetryStorage] Failed to insert telemetry turn`）。

## 根因

WAL 模式下多进程共享同库，`SQLITE_BUSY` 有两类：

1. 普通写锁等待 —— 走 busy handler，受连接级 busy_timeout 保护。
2. `SQLITE_BUSY_SNAPSHOT` —— deferred 事务（better-sqlite3 `db.transaction(fn)` 默认
   `BEGIN`）先读后写、升级写锁时发现读快照已被别的连接改写。**不进 busy handler**，
   sqlite 立即抛 `database is locked`。`SessionRepository.addMessage` 的账本事务
   正是这个形状（SELECT persistedRow / readConversationBoundary 后再 append 账本），
   与夜跑 stderr 完全对上。

桌面主连接 busy_timeout 此前只靠 better-sqlite3 隐式默认，无常量约束。

## 方案（最小改动，不重写连接拓扑）

- `src/shared/constants/database.ts` 新增 `SQLITE_BUSY`：`BUSY_TIMEOUT_MS = 5_000`、
  `WRITE_RETRY_LIMIT = 2`（常量唯一源仓规 §5.1）。
- 写事务 IMMEDIATE 化：`SessionRepository.addMessage / replaceMessages / updateMessage`
  的写事务改 `.immediate()`（`BEGIN IMMEDIATE` 在事务入口就拿写锁，从根上消除
  快照升级冲突这一类）。
- 每写操作 busy 重试：新增 `runWithSqliteBusyRetry`（配套 `isSqliteBusyError`，认
  `SQLITE_BUSY*` code 与 `database is locked` 文案），套在消息写路径与
  telemetry `insertSession / insertTurn` 上，兜底 busy_timeout 到期的普通写锁等待。
- 连接初始化：桌面 `DatabaseService.openDatabaseConnection` 改为
  `new Database(path, { timeout: SQLITE_BUSY.BUSY_TIMEOUT_MS })`，覆盖 WAL pragma
  与日常写；CLI 连接 open 时已有 timeout（30s，更宽）不动。
- 失败不静默：重试耗尽后 CLI persist 路径（`src/cli/session.ts`、`src/cli/bootstrap.ts`）
  与 telemetry 写路径改结构化日志（稳定 code + sessionId/messageId/turnId + sqliteCode）。
- updated_at 仓规：`options?.updatedAt ?? Date.now()` 的可选时间戳参数形状原样保留，未触碰。

## 反向变异

变异：把 `runWithSqliteBusyRetry` 的 `attempts` 改回 `1`（不重试）。

```
 ❯ tests/unit/database/sqliteBusyConcurrency.test.ts (9 tests | 2 failed) 381ms
 FAIL  tests/unit/database/sqliteBusyConcurrency.test.ts > runWithSqliteBusyRetry > busy 后自动重试直到成功
 FAIL  tests/unit/database/sqliteBusyConcurrency.test.ts > runWithSqliteBusyRetry > 重试耗尽仍 busy 则抛出，总次数 = 1 + WRITE_RETRY_LIMIT
AssertionError: expected "vi.fn()" to be called 3 times, but got 1 times
 Test Files  1 failed (1)
      Tests  2 failed | 7 passed (9)
```

还原后同文件 9/9 转绿。

## 测试

- `npx vitest run tests/unit/database/sqliteBusyConcurrency.test.ts`：9/9
  （busy 分类 / 重试语义 / 同进程双连接写锁占用-释放 / 6 连接 Promise.all 同写 /
  8 个子进程并发写同一 WAL 库零 `database is locked`、320 行全齐）。
- 相关存量回归：`tests/unit/repositories/sessionRepositoryFts.test.ts` +
  `tests/unit/database/ftsRepair.test.ts` + `tests/unit/database/sqliteErrors.test.ts`
  60/60；`tests/unit/telemetry` + `webSessionStore.cliSessionManager` 105/105；
  `tests/unit/cli` + `sessionManagerTerminalFrameCleanup` 333/333。
- `npm run typecheck` 通过。
- `node scripts/gates-fast.mjs --regressions /tmp/regressions-1992.json` 通过，
  回执 receipt=4bff2741-e990-4c57-99b6-9f1d60ea8409。

证据档位：static-contract（typecheck/eslint）+ hermetic-protocol（重试语义与协议单测）
+ fault-injection（attempts=1 变异两测真红后还原）+ real-runtime（8 真实子进程并发写共享 WAL 库）。


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=501fa5043b259353aa5603252da7f61f52395709 base=a5ca056be0b1803312259441b9837698368ad8ea receipt=41dc77e2-283e-462f-a8fa-1edeb8ab937c

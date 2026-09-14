/**
 * 只读降级模式（RQ-185 刀3）。
 *
 * 触发点（与刀2 合入版编排对齐，优先级：自愈恢复 > readonly > 内存模式）：
 * - restoreFromBackupOrThrow 无备份分支：库已隔离 + .db-unrecoverable 已落盘，
 *   先把隔离副本只读打开给用户读历史，打不开才抛 DB_CORRUPT_NO_BACKUP 进内存模式；
 * - 启动时 .db-unrecoverable 分支：自愈口子（好备份+磁盘够 → 再试恢复）优先，
 *   自愈不了再只读打开标记里的隔离副本，最后才按标记 code 抛出。
 * 局部表损坏但库还可写时不进 readonly（刀2 ai-review 决定：留在当前库 degraded，
 * 由账本 corruption 计数兜底）。
 *
 * WAL 取舍（better-sqlite3 13 在本仓实测，证据见 N-SQLITE-DEGRADE-K3）：
 * - 打开方式：`new Database(path, { readonly: true, fileMustExist: true })`。
 *   再加 `PRAGMA query_only = ON` 作第二道闸。
 * - 不用 `file:...?immutable=1` / `mode=ro` URI：本栈会 SQLITE_CANTOPEN。
 * - 不用 checkpoint：checkpoint 是写，只读降级不许动坏库内容。
 * - 不用删 -wal/-shm：损坏文件永不删除。
 * - 副作用：对已经 checkpoint 干净的 WAL 库，readonly 连接可能创建空的
 *   `-wal`（0 字节）和 `-shm`（32KB）。这是 SQLite 读 WAL 库的索引文件，
 *   不是主库内容变更；关连接后留着，下一次写打开会接着用。
 *
 * 交互语义（进程级 degradedMode，与正常可写模式明确区分）：
 * - 可用：读历史（sessions/messages）、搜索（FTS 或 LIKE 兜底）。
 * - 拒绝：新会话、写消息、写记忆、起 durable run、schema/migration/VACUUM、
 *   账本 append（仍 fail-safe 吞掉，不把只读拒绝当成 corruption）。
 * - 可逆：不改坏库页内容；有备份时仍走隔离+恢复，而不是只读。
 */

import type BetterSqlite3 from 'better-sqlite3';
import { DatabaseReadOnlyError } from './sqliteErrors';

type SqliteDatabaseConstructor = {
  new (filename: string, options?: BetterSqlite3.Options): BetterSqlite3.Database;
};

function wrapDatabaseAsReadOnly(db: BetterSqlite3.Database): BetterSqlite3.Database {
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const stmt = originalPrepare(sql);
    stmt.run = (() => {
      throw new DatabaseReadOnlyError();
    }) as typeof stmt.run;
    return stmt;
  }) as typeof db.prepare;

  db.exec = (() => {
    throw new DatabaseReadOnlyError();
  }) as typeof db.exec;

  db.transaction = (() => {
    throw new DatabaseReadOnlyError();
  }) as typeof db.transaction;

  if (typeof db.backup === 'function') {
    db.backup = (() => {
      throw new DatabaseReadOnlyError();
    }) as typeof db.backup;
  }

  return db;
}

export function openReadOnlyDatabase(
  databaseConstructor: SqliteDatabaseConstructor,
  filePath: string,
): BetterSqlite3.Database {
  const db = new databaseConstructor(filePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
  } catch {
    // query_only is optional; SQLITE_OPEN_READONLY already refuses writes.
  }
  return wrapDatabaseAsReadOnly(db);
}

export function assertDatabaseWritable(degradedMode: boolean): void {
  if (degradedMode) throw new DatabaseReadOnlyError();
}

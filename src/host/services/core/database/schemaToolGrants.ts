import type BetterSqlite3 from 'better-sqlite3';
import type { Logger } from './schemaHelpers';

/**
 * 工具授权 24h 档落这一张表（N-PERM-GRANT-TIERS）：重启不得破坏「24 小时内允许」的
 * 承诺。run 档随 run 结束清除，只活在本进程内存（toolGrantStore），不进库。
 * CREATE TABLE IF NOT EXISTS 天然幂等——重复跑是 no-op，无存量列需补。
 */
export function applyToolGrantsSchema(db: BetterSqlite3.Database, _logger: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_permission_grants (
      tool_key TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      target TEXT,
      granted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
}

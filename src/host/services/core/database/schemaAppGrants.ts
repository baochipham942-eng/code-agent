import type BetterSqlite3 from 'better-sqlite3';
import type { Logger } from './schemaHelpers';

/** 电脑操作「始终允许」按应用落这一张表。会话内授权不进库。 */
export function applyAppGrantsSchema(db: BetterSqlite3.Database, _logger: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_permission_grants (
      app_key TEXT PRIMARY KEY,
      bundle_id TEXT,
      app_name TEXT NOT NULL,
      granted_at INTEGER NOT NULL
    )
  `);
}

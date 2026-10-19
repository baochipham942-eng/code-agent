import type BetterSqlite3 from 'better-sqlite3';
import type { Logger } from './schemaHelpers';

/** 电脑操作「始终允许」按应用落这一张表。会话内授权不进库。 */
export function applyAppGrantsSchema(db: BetterSqlite3.Database, _logger: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_permission_grants (
      app_key TEXT PRIMARY KEY,
      bundle_id TEXT,
      app_name TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      expires_at INTEGER
    )
  `);
  // 存量库升级：建表语句只对新建库生效，老表用 PRAGMA table_info 探列后补
  // （N-PERM-GRANT-LEDGER 的可空过期列）。守卫保证 ALTER 幂等——重复跑是 no-op。
  const columns = db.prepare('PRAGMA table_info(app_permission_grants)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'expires_at')) {
    db.exec('ALTER TABLE app_permission_grants ADD COLUMN expires_at INTEGER');
  }
}

// ============================================================================
// Schema Helpers - schema.ts / schemaTelemetry.ts 共用的建表小工具
// ============================================================================
// 从 schema.ts 平移抽出（纯代码搬移，无行为变更）。

import type BetterSqlite3 from 'better-sqlite3';
import type { createLogger } from '../../infra/logger';

export type Logger = ReturnType<typeof createLogger>;

export function tableExists(db: BetterSqlite3.Database, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName) as
    | { name?: string }
    | undefined;
  return row?.name === tableName;
}

export function safeAlter(db: BetterSqlite3.Database, sql: string, logger: Logger): void {
  try {
    db.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      logger.warn('[DB] Migration unexpected error:', msg);
    }
  }
}

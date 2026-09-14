import type BetterSqlite3 from 'better-sqlite3';
import { safeAlter, type Logger } from './schemaHelpers';

export function applyAnnotationsSchema(db: BetterSqlite3.Database, logger: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      overall TEXT CHECK (overall IN ('up','down')),
      note TEXT,
      dims_json TEXT NOT NULL DEFAULT '{}',
      consent_scope TEXT NOT NULL DEFAULT 'metadata',
      calibration_split TEXT,
      supersedes_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
    )
  `);
  // 归因三件套 + 定级（ADR-071 D4）。一列 JSON 而不是四列：字段还会随定级公式演进，
  // 表是 append-only（改判 = 追加一行、supersedes_id 指旧行），历史行天然留着旧 schema
  // 的快照。「取消归因」与 #1823 的「取消金标」同一套语义：追加一条这一列为 null 的新行。
  safeAlter(db, 'ALTER TABLE annotations ADD COLUMN attribution_json TEXT', logger);
}

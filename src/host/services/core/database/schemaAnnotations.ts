import type BetterSqlite3 from 'better-sqlite3';
import type { Logger } from './schemaHelpers';

export function applyAnnotationsSchema(db: BetterSqlite3.Database, _logger: Logger): void {
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
}

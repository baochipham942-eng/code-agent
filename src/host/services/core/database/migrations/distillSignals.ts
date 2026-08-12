import type BetterSqlite3 from 'better-sqlite3';
import type { Logger } from '../schemaHelpers';

/** ADR-034 Layer 1: cross-session distillation signals and delivered suggestions. */
export function applyDistillSignalsMigration(db: BetterSqlite3.Database, logger: Logger): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS distill_signals (
        pattern_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (pattern_key, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_distill_signals_pattern
        ON distill_signals(pattern_key, created_at);

      CREATE TABLE IF NOT EXISTS distill_suggestions (
        id TEXT PRIMARY KEY,
        pattern_key TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_distill_suggestions_created
        ON distill_suggestions(created_at);
      CREATE INDEX IF NOT EXISTS idx_distill_suggestions_pattern
        ON distill_suggestions(pattern_key, created_at);
    `);
  } catch (error) {
    logger.warn('[DB] Distill signals migration failed:', error);
  }
}

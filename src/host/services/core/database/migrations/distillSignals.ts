import type BetterSqlite3 from 'better-sqlite3';
import type { Logger } from '../schemaHelpers';

/** ADR-034 Layer 1 + 4: cross-session signals, promotion gate, and usage voting. */
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

      CREATE TABLE IF NOT EXISTS distill_skill_lifecycle (
        skill_name TEXT PRIMARY KEY,
        pattern_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'split_pending', 'retired', 'merged')),
        initial_positive_evidence INTEGER NOT NULL,
        importance_count INTEGER NOT NULL,
        promoted_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        retired_at INTEGER,
        merged_into TEXT
      );

      CREATE TABLE IF NOT EXISTS distill_skill_votes (
        skill_name TEXT NOT NULL,
        event_key TEXT NOT NULL,
        session_id TEXT,
        task_class TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('adopted', 'skipped', 'negative_feedback')),
        delta INTEGER NOT NULL CHECK (delta IN (-1, 1)),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (skill_name, event_key),
        FOREIGN KEY (skill_name) REFERENCES distill_skill_lifecycle(skill_name) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_distill_skill_votes_task
        ON distill_skill_votes(skill_name, task_class, created_at);

      CREATE TABLE IF NOT EXISTS distill_skill_turn_signals (
        turn_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        session_id TEXT,
        task_class TEXT NOT NULL DEFAULT 'unknown',
        selected INTEGER NOT NULL DEFAULT 0,
        adopted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (turn_id, skill_name),
        FOREIGN KEY (skill_name) REFERENCES distill_skill_lifecycle(skill_name) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_distill_skill_turn_signals_turn
        ON distill_skill_turn_signals(turn_id, created_at);
    `);
  } catch (error) {
    logger.warn('[DB] Distill signals migration failed:', error);
  }
}

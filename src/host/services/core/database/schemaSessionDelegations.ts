import type BetterSqlite3 from 'better-sqlite3';
import type { Logger } from './schemaHelpers';

// ADR-072 D5. DDL only: this fragment never alters another table.
// `logger` matches the other applySchema fragments; there is no ALTER to report.
export function applySessionDelegationsSchema(db: BetterSqlite3.Database, _logger: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_delegations (
      delegation_id TEXT PRIMARY KEY NOT NULL,
      origin_session_id TEXT NOT NULL,
      origin_turn_id TEXT NOT NULL,
      disposition TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      target_message_id TEXT,
      target_queued_input_id TEXT,
      target_run_id TEXT,
      submission_key TEXT NOT NULL UNIQUE,
      action_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      supersedes_delegation_id TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution_json TEXT,
      CHECK (status IN ('active','superseded','stopped','aborted','terminal_observed')),
      CHECK (disposition IN ('delegate_existing','create_new'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_delegations_target_status
      ON session_delegations (target_session_id, status);

    CREATE INDEX IF NOT EXISTS idx_session_delegations_target_queued_input
      ON session_delegations (target_queued_input_id);

    CREATE INDEX IF NOT EXISTS idx_session_delegations_target_run
      ON session_delegations (target_run_id);

    CREATE INDEX IF NOT EXISTS idx_session_delegations_origin_turn
      ON session_delegations (origin_session_id, origin_turn_id);
  `);
}

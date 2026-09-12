import type BetterSqlite3 from 'better-sqlite3';

/** Durable Host state used by the companion gateway. Safe on old databases. */
export function applyCompanionSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_session_cleanup (session_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS companion_devices (
      device_id TEXT PRIMARY KEY,
      credential_hash TEXT NOT NULL DEFAULT '',
      scope_json TEXT NOT NULL,
      scope_epoch INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS companion_commands (
      device_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      action TEXT NOT NULL,
      session_id TEXT,
      state TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, command_id)
    );
    CREATE TABLE IF NOT EXISTS companion_events (
      event_id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      session_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(epoch, seq)
    );
    CREATE TABLE IF NOT EXISTS companion_decisions (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      resolved_by TEXT,
      operation_digest TEXT
    );
    CREATE TABLE IF NOT EXISTS companion_decision_claims (
      request_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      operation_digest TEXT NOT NULL,
      PRIMARY KEY (request_id, revision, operation_digest)
    );
    CREATE TABLE IF NOT EXISTS companion_identity_keys (
      public_key TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE REFERENCES companion_devices(device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_companion_events_session_seq
      ON companion_events(session_id, epoch, seq);
    CREATE INDEX IF NOT EXISTS idx_companion_events_created_at
      ON companion_events(created_at);
    CREATE TABLE IF NOT EXISTS companion_file_transfers (
      transfer_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      received INTEGER NOT NULL,
      state TEXT NOT NULL,
      staging_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_companion_file_transfers_state_created
      ON companion_file_transfers(state, created_at);
    CREATE TABLE IF NOT EXISTS companion_artifacts (
      artifact_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      path TEXT NOT NULL,
      origin TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_companion_artifacts_session
      ON companion_artifacts(session_id, created_at);
  `);
  // Companion unit tests use an isolated SQLite file without `sessions`.
  // The host schema creates that table first; attach the cascade only then.
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`).get()) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS companion_forget_deleted_session
      AFTER UPDATE OF is_deleted ON sessions
      WHEN NEW.is_deleted = 1 AND OLD.is_deleted = 0
      BEGIN
        DELETE FROM companion_events WHERE session_id = NEW.id;
        DELETE FROM companion_decisions WHERE session_id = NEW.id;
        INSERT OR IGNORE INTO companion_session_cleanup (session_id) VALUES (NEW.id);
      END;
    `);
  }
}

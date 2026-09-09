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
  `);
  try {
    db.exec("ALTER TABLE companion_devices ADD COLUMN credential_hash TEXT NOT NULL DEFAULT ''");
  } catch (error) {
    if (!(error instanceof Error) || !/duplicate column|already exists/i.test(error.message)) throw error;
  }
}

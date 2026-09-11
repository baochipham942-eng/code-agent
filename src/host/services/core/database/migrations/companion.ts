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
    CREATE TABLE IF NOT EXISTS companion_push_registrations (
      device_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      environment TEXT NOT NULL,
      token_wrap TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      registered_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS companion_push_outbox (
      event_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      route_token TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(event_id, device_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_companion_push_outbox_state_expires
      ON companion_push_outbox(state, expires_at);
  `);
}

import type BetterSqlite3 from 'better-sqlite3';

/**
 * Durable local storage for versioned Session Fork export/import envelopes.
 *
 * The export payload is immutable once admitted. Sync rows deliberately remain
 * mutable because they are a recoverable local projection of transport state.
 * No table in this fragment owns or cascades into sessions/messages.
 */
export function applySessionForkPortabilitySchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_fork_portability_exports (
      export_id TEXT PRIMARY KEY,
      owner_scope_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK (mode IN ('subtree', 'detached_child'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_fork_portability_exports_scope
      ON session_fork_portability_exports (
        owner_scope_id, project_id, created_at, export_id
      );

    CREATE TABLE IF NOT EXISTS session_fork_portability_imports (
      import_id TEXT PRIMARY KEY,
      source_export_id TEXT NOT NULL,
      source_payload_digest TEXT NOT NULL,
      target_owner_scope_id TEXT NOT NULL,
      target_project_id TEXT NOT NULL,
      import_namespace TEXT NOT NULL,
      imported_root_session_id TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (
        source_export_id,
        target_owner_scope_id,
        target_project_id,
        import_namespace
      )
    );

    CREATE INDEX IF NOT EXISTS idx_session_fork_portability_imports_scope
      ON session_fork_portability_imports (
        target_owner_scope_id, target_project_id, created_at, import_id
      );

    CREATE TABLE IF NOT EXISTS session_fork_portability_sync (
      direction TEXT NOT NULL,
      sync_envelope_id TEXT NOT NULL,
      owner_scope_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      dependency_ids_json TEXT NOT NULL DEFAULT '[]',
      envelope_json TEXT NOT NULL,
      state TEXT NOT NULL,
      reason TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (direction, sync_envelope_id),
      CHECK (direction IN ('outbox', 'inbox')),
      CHECK (state IN (
        'local_only', 'pending', 'quarantined', 'ready', 'applied', 'blocked'
      )),
      CHECK (attempt_count >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_session_fork_portability_sync_scope_state
      ON session_fork_portability_sync (
        owner_scope_id, project_id, direction, state, updated_at, sync_envelope_id
      );

    CREATE TRIGGER IF NOT EXISTS session_fork_portability_exports_immutable_update
    BEFORE UPDATE ON session_fork_portability_exports
    BEGIN
      SELECT RAISE(ABORT, 'session fork portability export is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS session_fork_portability_exports_immutable_delete
    BEFORE DELETE ON session_fork_portability_exports
    BEGIN
      SELECT RAISE(ABORT, 'session fork portability export is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS session_fork_portability_imports_immutable_update
    BEFORE UPDATE ON session_fork_portability_imports
    BEGIN
      SELECT RAISE(ABORT, 'session fork portability import record is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS session_fork_portability_imports_immutable_delete
    BEFORE DELETE ON session_fork_portability_imports
    BEGIN
      SELECT RAISE(ABORT, 'session fork portability import record is immutable');
    END;
  `);
}

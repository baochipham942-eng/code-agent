import type BetterSqlite3 from 'better-sqlite3';

/**
 * S0 migration draft. It is intentionally not called by DatabaseService yet.
 * S1 owns production repository wiring and the rollout switch.
 */
export function applyDurableRunMigrationDraft(db: BetterSqlite3.Database): void {
  widenDurableRunsEngineKindCheck(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_runs (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_run_id TEXT,
      engine_kind TEXT NOT NULL CHECK (engine_kind IN ('native','agent_team','dynamic_workflow','external_cli','subagent_single')),
      engine_ref_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('created','running','waiting','paused','recovering','completed','failed','cancelled')),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      next_event_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_event_seq >= 1),
      checkpoint_seq INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_seq >= 0),
      envelope_json TEXT NOT NULL,
      owner_id TEXT,
      process_instance_id TEXT,
      owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0),
      lease_expires_at INTEGER,
      terminal_event_seq INTEGER,
      terminal_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (owner_epoch = 0 AND owner_id IS NULL AND process_instance_id IS NULL AND lease_expires_at IS NULL)
        OR (owner_epoch >= 1 AND owner_id IS NOT NULL AND process_instance_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      ),
      CHECK (
        (status IN ('completed','failed','cancelled') AND terminal_event_seq IS NOT NULL AND terminal_at IS NOT NULL)
        OR (status NOT IN ('completed','failed','cancelled') AND terminal_event_seq IS NULL AND terminal_at IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_durable_runs_session ON durable_runs (session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_durable_runs_recovery ON durable_runs (status, lease_expires_at);
    DROP INDEX IF EXISTS idx_durable_runs_active_session;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_runs_active_session
      ON durable_runs (session_id)
      WHERE parent_run_id IS NULL
        AND status IN ('created','running','waiting','paused','recovering');

    CREATE TABLE IF NOT EXISTS durable_run_attempts (
      run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      process_instance_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 1),
      status TEXT NOT NULL CHECK (status IN ('starting','active','ended','lost')),
      resumed_from_checkpoint_seq INTEGER,
      recovery_reason TEXT CHECK (recovery_reason IS NULL OR recovery_reason IN ('process_exit','lease_expired','manual_retry')),
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      PRIMARY KEY (run_id, attempt),
      FOREIGN KEY (run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS durable_run_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      event_type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq),
      FOREIGN KEY (run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_run_events_run_seq ON durable_run_events (run_id, seq);

    CREATE TABLE IF NOT EXISTS durable_run_checkpoints (
      run_id TEXT NOT NULL,
      checkpoint_seq INTEGER NOT NULL CHECK (checkpoint_seq >= 1),
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      event_seq INTEGER NOT NULL CHECK (event_seq >= 0),
      status TEXT NOT NULL CHECK (status IN ('running','waiting','paused','recovering','completed','failed','cancelled')),
      cursor_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      checksum TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, checkpoint_seq),
      UNIQUE (run_id, event_seq),
      FOREIGN KEY (run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS durable_run_pending_operations (
      run_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      kind TEXT NOT NULL CHECK (kind IN ('model_call','tool_call','approval','child_run','external_engine')),
      status TEXT NOT NULL CHECK (status IN ('prepared','dispatched','waiting','succeeded','failed','abandoned','unknown')),
      idempotency_key TEXT NOT NULL,
      side_effect INTEGER NOT NULL CHECK (side_effect IN (0, 1)),
      requires_human_confirmation INTEGER NOT NULL DEFAULT 0 CHECK (requires_human_confirmation IN (0, 1)),
      input_json TEXT NOT NULL,
      input_digest TEXT,
      provider_operation_id TEXT,
      result_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, operation_id),
      UNIQUE (run_id, idempotency_key),
      FOREIGN KEY (run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_durable_run_pending_status ON durable_run_pending_operations (run_id, status);

    CREATE TABLE IF NOT EXISTS durable_run_children (
      parent_run_id TEXT NOT NULL,
      child_run_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('agent','workflow','delegated_engine')),
      status TEXT NOT NULL CHECK (status IN ('created','running','waiting','paused','recovering','completed','failed','cancelled')),
      created_at INTEGER NOT NULL,
      terminal_at INTEGER,
      PRIMARY KEY (parent_run_id, child_run_id),
      FOREIGN KEY (parent_run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_durable_run_children_child ON durable_run_children (child_run_id);
  `);
}

/** Rollback is lossful only for the unused draft tables; legacy session/event tables are untouched. */
export function rollbackDurableRunMigrationDraft(db: BetterSqlite3.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS durable_run_children;
    DROP TABLE IF EXISTS durable_run_pending_operations;
    DROP TABLE IF EXISTS durable_run_checkpoints;
    DROP TABLE IF EXISTS durable_run_events;
    DROP TABLE IF EXISTS durable_run_attempts;
    DROP TABLE IF EXISTS durable_runs;
  `);
}

/**
 * N-BGSPAWN-DURABLE：durable_runs.engine_kind 的 CHECK 原先只放 4 种 engine，
 * 后台单子代理收口需要 'subagent_single'。SQLite 不能 ALTER CHECK，已建库只能
 * 建新表搬数据再改名。子表（attempts/events/...）带 ON DELETE CASCADE 外键指向
 * durable_runs，DROP 母表时若 foreign_keys 还开着会把子表行级联清掉，所以重建
 * 全程在 foreign_keys=OFF 下做（pragma 在事务外切换才生效），结束后恢复。
 * 索引随 DROP TABLE 一起消失，由上面 exec 里的 CREATE INDEX IF NOT EXISTS 重建。
 */
function widenDurableRunsEngineKindCheck(db: BetterSqlite3.Database): void {
  const row = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'durable_runs' LIMIT 1
  `).get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'subagent_single'")) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE durable_runs_new (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          parent_run_id TEXT,
          engine_kind TEXT NOT NULL CHECK (engine_kind IN ('native','agent_team','dynamic_workflow','external_cli','subagent_single')),
          engine_ref_json TEXT,
          status TEXT NOT NULL CHECK (status IN ('created','running','waiting','paused','recovering','completed','failed','cancelled')),
          attempt INTEGER NOT NULL CHECK (attempt >= 1),
          next_event_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_event_seq >= 1),
          checkpoint_seq INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_seq >= 0),
          envelope_json TEXT NOT NULL,
          owner_id TEXT,
          process_instance_id TEXT,
          owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0),
          lease_expires_at INTEGER,
          terminal_event_seq INTEGER,
          terminal_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (
            (owner_epoch = 0 AND owner_id IS NULL AND process_instance_id IS NULL AND lease_expires_at IS NULL)
            OR (owner_epoch >= 1 AND owner_id IS NOT NULL AND process_instance_id IS NOT NULL AND lease_expires_at IS NOT NULL)
          ),
          CHECK (
            (status IN ('completed','failed','cancelled') AND terminal_event_seq IS NOT NULL AND terminal_at IS NOT NULL)
            OR (status NOT IN ('completed','failed','cancelled') AND terminal_event_seq IS NULL AND terminal_at IS NULL)
          )
        );
        INSERT INTO durable_runs_new (
          run_id, session_id, parent_run_id, engine_kind, engine_ref_json, status, attempt,
          next_event_seq, checkpoint_seq, envelope_json, owner_id, process_instance_id,
          owner_epoch, lease_expires_at, terminal_event_seq, terminal_at, created_at, updated_at
        )
        SELECT
          run_id, session_id, parent_run_id, engine_kind, engine_ref_json, status, attempt,
          next_event_seq, checkpoint_seq, envelope_json, owner_id, process_instance_id,
          owner_epoch, lease_expires_at, terminal_event_seq, terminal_at, created_at, updated_at
        FROM durable_runs;
        DROP TABLE durable_runs;
        ALTER TABLE durable_runs_new RENAME TO durable_runs;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

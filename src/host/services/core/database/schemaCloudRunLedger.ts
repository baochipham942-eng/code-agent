import type BetterSqlite3 from 'better-sqlite3';
import { CLOUD_RUN_STATES, CLOUD_RUN_TRIGGERS } from '../../../../shared/contract/cloudRun';
import { safeAlter, type Logger } from './schemaHelpers';

// ============================================================================
// Cloud run ledger schema — ADR-086 S1–S3. DDL only, 同 applySessionDelegationsSchema 形状。
// - state / "trigger" 的 CHECK 列表由合同常量生成（单一事实源，与迁移表同源）。
// - workspace_status 故意只给 DEFAULT 'active' 不加 CHECK：保留期词汇
//   （active/…/cleaned 等）由 RETENTION-SRV 拍板，先钉枚举会猜错词表。
// - run_id / account_id / session_id / workspace_id 的不可变由 BEFORE UPDATE
//   触发器兜底（合同 2：runId 写入后不变；workspace 只挂这一 runId，不换绑）。
// ============================================================================

function sqlLiteralList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export function applyCloudRunLedgerSchema(db: BetterSqlite3.Database, logger: Logger): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      "trigger" TEXT NOT NULL CHECK ("trigger" IN (${sqlLiteralList(CLOUD_RUN_TRIGGERS)})),
      state TEXT NOT NULL CHECK (state IN (${sqlLiteralList(CLOUD_RUN_STATES)})),
      workspace_id TEXT NOT NULL,
      workspace_status TEXT NOT NULL DEFAULT 'active',
      retention_notice_at INTEGER,
      export_available INTEGER,
      enqueued_seq INTEGER,
      request_json TEXT,
      client_message_id TEXT,
      execution_run_id TEXT,
      cancel_requested_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cloud_runs_account_state
      ON cloud_runs (account_id, state);

    CREATE INDEX IF NOT EXISTS idx_cloud_runs_session
      ON cloud_runs (session_id);

    CREATE TABLE IF NOT EXISTS cloud_run_transitions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cloud_run_transitions_run
      ON cloud_run_transitions (run_id, seq);

    CREATE TRIGGER IF NOT EXISTS trg_cloud_runs_run_id_immutable
    BEFORE UPDATE ON cloud_runs
    WHEN OLD.run_id != NEW.run_id
    BEGIN
      SELECT RAISE(ABORT, 'cloud_runs.run_id is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_cloud_runs_account_id_immutable
    BEFORE UPDATE ON cloud_runs
    WHEN OLD.account_id != NEW.account_id
    BEGIN
      SELECT RAISE(ABORT, 'cloud_runs.account_id is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_cloud_runs_session_id_immutable
    BEFORE UPDATE ON cloud_runs
    WHEN OLD.session_id != NEW.session_id
    BEGIN
      SELECT RAISE(ABORT, 'cloud_runs.session_id is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_cloud_runs_workspace_id_immutable
    BEFORE UPDATE ON cloud_runs
    WHEN OLD.workspace_id != NEW.workspace_id
    BEGIN
      SELECT RAISE(ABORT, 'cloud_runs.workspace_id is immutable');
    END;

  `);

  safeAlter(db, 'ALTER TABLE cloud_runs ADD COLUMN enqueued_seq INTEGER', logger);
  safeAlter(db, 'ALTER TABLE cloud_runs ADD COLUMN request_json TEXT', logger);
  safeAlter(db, 'ALTER TABLE cloud_runs ADD COLUMN client_message_id TEXT', logger);
  safeAlter(db, 'ALTER TABLE cloud_runs ADD COLUMN execution_run_id TEXT', logger);
  safeAlter(db, 'ALTER TABLE cloud_runs ADD COLUMN cancel_requested_at INTEGER', logger);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_runs_client_message
      ON cloud_runs (account_id, session_id, client_message_id)
      WHERE client_message_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_cloud_runs_account_queue
      ON cloud_runs (account_id, state, enqueued_seq);

    CREATE TRIGGER IF NOT EXISTS trg_cloud_runs_execution_run_id_set_once
    BEFORE UPDATE ON cloud_runs
    WHEN OLD.execution_run_id IS NOT NULL AND NEW.execution_run_id != OLD.execution_run_id
    BEGIN
      SELECT RAISE(ABORT, 'cloud_runs.execution_run_id can only be set once');
    END;
  `);
}

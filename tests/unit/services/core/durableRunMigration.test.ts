import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import {
  applyDurableRunMigrationDraft,
  rollbackDurableRunMigrationDraft,
} from '../../../../src/host/services/core/database/migrations/durableRun';

const TABLES = [
  'durable_runs',
  'durable_run_attempts',
  'durable_run_events',
  'durable_run_checkpoints',
  'durable_run_pending_operations',
  'durable_run_children',
];

function tableNames(db: Database.Database): string[] {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map((row) => (row as { name: string }).name);
}

describe('Durable Run migration draft', () => {
  it('adds isolated, append-safe run tables without changing legacy session data', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO sessions (id, status) VALUES ('session-1', 'running');
    `);

    applyDurableRunMigrationDraft(db);

    expect(tableNames(db)).toEqual(expect.arrayContaining(TABLES));
    expect(db.prepare('SELECT * FROM sessions').get()).toEqual({ id: 'session-1', status: 'running' });

    const eventIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'durable_run_events'").all()
      .map((row) => (row as { name: string }).name);
    expect(eventIndexes).toContain('idx_durable_run_events_run_seq');

    db.close();
  });

  it('is idempotent and enforces per-run event seq plus stable idempotency keys', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyDurableRunMigrationDraft(db);
    applyDurableRunMigrationDraft(db);

    db.prepare(`
      INSERT INTO durable_runs
        (run_id, session_id, engine_kind, status, attempt, next_event_seq, checkpoint_seq, envelope_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('run-1', 'session-1', 'native', 'running', 1, 2, 0, '{}', 1, 1);
    db.prepare(`INSERT INTO durable_run_events (run_id, seq, attempt, event_type, event_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('run-1', 1, 1, 'run_started', '{}', 1);
    expect(() => db.prepare(`INSERT INTO durable_run_events (run_id, seq, attempt, event_type, event_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('run-1', 1, 1, 'duplicate', '{}', 2)).toThrow();

    const insertOperation = db.prepare(`
      INSERT INTO durable_run_pending_operations
        (run_id, operation_id, attempt, kind, status, idempotency_key, side_effect, input_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOperation.run('run-1', 'op-1', 1, 'tool_call', 'prepared', 'run-1:tool-call-1', 1, '{}', 1, 1);
    expect(() => insertOperation.run('run-1', 'op-2', 2, 'tool_call', 'prepared', 'run-1:tool-call-1', 1, '{}', 2, 2)).toThrow();

    db.close();
  });

  it('rolls back only the draft tables and preserves legacy tables', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions (id) VALUES ('session-1')`);
    applyDurableRunMigrationDraft(db);

    rollbackDurableRunMigrationDraft(db);
    rollbackDurableRunMigrationDraft(db);

    expect(tableNames(db)).not.toEqual(expect.arrayContaining(TABLES));
    expect(db.prepare('SELECT id FROM sessions').get()).toEqual({ id: 'session-1' });
    db.close();
  });
});

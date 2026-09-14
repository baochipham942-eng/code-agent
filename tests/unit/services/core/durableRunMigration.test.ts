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

  it('widens the engine_kind CHECK on existing databases without losing rows (N-BGSPAWN-DURABLE)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // 模拟已建库：旧 CHECK 只有 4 种 engine kind。
    db.exec(`
      CREATE TABLE durable_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_run_id TEXT,
        engine_kind TEXT NOT NULL CHECK (engine_kind IN ('native','agent_team','dynamic_workflow','external_cli')),
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
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE durable_run_attempts (
        run_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        process_instance_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        owner_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        resumed_from_checkpoint_seq INTEGER,
        recovery_reason TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        PRIMARY KEY (run_id, attempt),
        FOREIGN KEY (run_id) REFERENCES durable_runs(run_id) ON DELETE CASCADE
      );
      INSERT INTO durable_runs
        (run_id, session_id, engine_kind, status, attempt, envelope_json, created_at, updated_at)
        VALUES ('run-legacy', 'session-1', 'native', 'running', 1, '{}', 1, 1);
      INSERT INTO durable_run_attempts
        (run_id, attempt, process_instance_id, owner_id, owner_epoch, status, started_at)
        VALUES ('run-legacy', 1, 'p1', 'owner', 1, 'active', 1);
    `);

    applyDurableRunMigrationDraft(db);

    // 旧行与子表行都还在（重建期间 foreign_keys 必须关闭，否则 DROP 母表级联清子表）
    expect(db.prepare('SELECT run_id, engine_kind FROM durable_runs').all())
      .toEqual([{ run_id: 'run-legacy', engine_kind: 'native' }]);
    expect(db.prepare('SELECT run_id FROM durable_run_attempts').all()).toEqual([{ run_id: 'run-legacy' }]);

    // 新 kind 已放行；不在清单里的 kind 仍被 CHECK 挡住
    db.prepare(`
      INSERT INTO durable_runs
        (run_id, session_id, parent_run_id, engine_kind, status, attempt, envelope_json, created_at, updated_at)
        VALUES ('run-bg', 'session-1', 'run-legacy', 'subagent_single', 'running', 1, '{}', 2, 2)
    `).run();
    expect(() => db.prepare(`
      INSERT INTO durable_runs
        (run_id, session_id, engine_kind, status, attempt, envelope_json, created_at, updated_at)
        VALUES ('run-bogus', 'session-2', 'bogus', 'running', 1, '{}', 3, 3)
    `).run()).toThrow();

    // 幂等：再跑一遍不再重建（行不丢、不重复）
    applyDurableRunMigrationDraft(db);
    expect(db.prepare('SELECT run_id FROM durable_runs ORDER BY run_id').all())
      .toEqual([{ run_id: 'run-bg' }, { run_id: 'run-legacy' }]);

    // 活跃根 run 部分唯一索引在重建后仍然生效
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'durable_runs'").all()
      .map((row) => (row as { name: string }).name);
    expect(indexes).toContain('idx_durable_runs_active_session');

    // 外键恢复为 ON（DatabaseService 的库级约定）
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  const createLegacyDurableRuns = (db: Database.Database, kinds: string) => {
    db.exec(`
      CREATE TABLE durable_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_run_id TEXT,
        engine_kind TEXT NOT NULL CHECK (engine_kind IN (${kinds})),
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
        updated_at INTEGER NOT NULL
      );
    `);
  };

  it('preserves kinds added by a branch merged earlier (loop-durable-k2 adds loop first)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // 模拟对方先合 main：已有库 CHECK 已含 'loop'。
    createLegacyDurableRuns(db, "'native','agent_team','dynamic_workflow','external_cli','loop'");
    db.prepare(`
      INSERT INTO durable_runs
        (run_id, session_id, engine_kind, status, attempt, envelope_json, created_at, updated_at)
        VALUES ('run-loop', 'session-1', 'loop', 'running', 1, '{}', 1, 1)
    `).run();

    applyDurableRunMigrationDraft(db);

    // 旧行保留，subagent_single 放行，且 'loop' 仍在 CHECK 里（插 loop 行不炸）
    expect(db.prepare('SELECT run_id, engine_kind FROM durable_runs').all())
      .toEqual([{ run_id: 'run-loop', engine_kind: 'loop' }]);
    db.prepare(`
      INSERT INTO durable_runs
        (run_id, session_id, engine_kind, status, attempt, envelope_json, created_at, updated_at)
        VALUES ('run-bg', 'session-2', 'subagent_single', 'running', 1, '{}', 2, 2)
    `).run();
    db.prepare(`
      INSERT INTO durable_runs
        (run_id, session_id, engine_kind, status, attempt, envelope_json, created_at, updated_at)
        VALUES ('run-loop-2', 'session-3', 'loop', 'running', 1, '{}', 3, 3)
    `).run();
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'durable_runs'").get() as { sql: string }).sql;
    expect(sql).toContain("'loop'");
    db.close();
  });

  it('is a no-op when subagent_single is already present', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createLegacyDurableRuns(db, "'native','subagent_single'");
    db.prepare(`
      INSERT INTO durable_runs
        (run_id, session_id, engine_kind, status, attempt, envelope_json, created_at, updated_at)
        VALUES ('run-1', 'session-1', 'native', 'running', 1, '{}', 1, 1)
    `).run();
    const before = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'durable_runs'").get() as { sql: string }).sql;

    applyDurableRunMigrationDraft(db);

    const after = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'durable_runs'").get() as { sql: string }).sql;
    expect(after).toBe(before);
    expect(db.prepare('SELECT run_id FROM durable_runs').all()).toEqual([{ run_id: 'run-1' }]);
    db.close();
  });

  it('keeps unknown kinds untouched when widening', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // 手工塞一个本分支不认识的 kind，重建后必须原样保留。
    createLegacyDurableRuns(db, "'native','future_x'");
    db.prepare(`
      INSERT INTO durable_runs
        (run_id, session_id, engine_kind, status, attempt, envelope_json, created_at, updated_at)
        VALUES ('run-future', 'session-1', 'future_x', 'running', 1, '{}', 1, 1)
    `).run();

    applyDurableRunMigrationDraft(db);

    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'durable_runs'").get() as { sql: string }).sql;
    expect(sql).toContain("'future_x'");
    expect(sql).toContain("'subagent_single'");
    expect(db.prepare('SELECT run_id, engine_kind FROM durable_runs').all())
      .toEqual([{ run_id: 'run-future', engine_kind: 'future_x' }]);
    db.close();
  });

  it('refuses to widen when another migration added a column the rebuild DDL does not know (ai-review 2026-09-14)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createLegacyDurableRuns(db, "'native'");
    db.exec(`ALTER TABLE durable_runs ADD COLUMN sync_revision INTEGER`);
    db.prepare(`
      INSERT INTO durable_runs
        (run_id, session_id, engine_kind, status, attempt, envelope_json, created_at, updated_at, sync_revision)
        VALUES ('run-extra', 'session-1', 'native', 'running', 1, '{}', 1, 1, 42)
    `).run();

    expect(() => applyDurableRunMigrationDraft(db)).toThrow(/refuse to widen/);

    // fail-closed：事务回滚，原表、原列、原数据原样还在；foreign_keys 恢复 ON。
    expect(db.prepare('SELECT run_id, sync_revision FROM durable_runs').all())
      .toEqual([{ run_id: 'run-extra', sync_revision: 42 }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_runs_new'").all())
      .toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('restores the caller foreign_keys state after widening (ai-review nit, same as PR#1804)', () => {
    const cases: Array<{ before: string; expected: number }> = [
      { before: 'OFF', expected: 0 },
      { before: 'ON', expected: 1 },
    ];
    for (const { before, expected } of cases) {
      const db = new Database(':memory:');
      db.pragma(`foreign_keys = ${before}`);
      createLegacyDurableRuns(db, "'native'");

      applyDurableRunMigrationDraft(db);

      expect(db.pragma('foreign_keys', { simple: true })).toBe(expected);
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'durable_runs'").get() as { sql: string }).sql;
      expect(sql).toContain("'subagent_single'");
      db.close();
    }
  });

  it('copies only the column intersection when the existing table predates a nullable column', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // 模拟更老的库：还没有可空列 engine_ref_json。交集复制后新表该列落 NULL，不炸不丢行。
    db.exec(`
      CREATE TABLE durable_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_run_id TEXT,
        engine_kind TEXT NOT NULL CHECK (engine_kind IN ('native')),
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
        updated_at INTEGER NOT NULL
      );
      INSERT INTO durable_runs
        (run_id, session_id, engine_kind, status, attempt, envelope_json, created_at, updated_at)
        VALUES ('run-old', 'session-1', 'native', 'running', 1, '{}', 1, 1);
    `);

    applyDurableRunMigrationDraft(db);

    expect(db.prepare('SELECT run_id, engine_kind, engine_ref_json FROM durable_runs').all())
      .toEqual([{ run_id: 'run-old', engine_kind: 'native', engine_ref_json: null }]);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'durable_runs'").get() as { sql: string }).sql;
    expect(sql).toContain("'subagent_single'");
    db.close();
  });
});

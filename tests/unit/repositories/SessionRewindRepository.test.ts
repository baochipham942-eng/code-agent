import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applyIndexes } from '../../../src/host/services/core/database/indexes';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

function totalChanges(db: BetterSqlite3.Database): number {
  const row = db.prepare(`
    SELECT total_changes() AS total_changes
  `).get() as { total_changes: number };
  return row.total_changes;
}

function seed(db: BetterSqlite3.Database): void {
  db.prepare(`
    INSERT INTO sessions (
      id, title, model_provider, model_name, session_type,
      created_at, updated_at, status, is_deleted
    ) VALUES ('session-1', 'Session', 'openai', 'gpt-5', 'chat', 1, 1, 'idle', 0)
  `).run();
  const insert = db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, timestamp, is_meta, visibility
    ) VALUES (?, 'session-1', ?, ?, ?, 0, 'active')
  `);
  insert.run('u1', 'user', 'one', 10);
  insert.run('a1', 'assistant', 'one answer', 20);
  insert.run('u2', 'user', 'two', 30);
  insert.run('a2', 'assistant', 'two answer', 40);
  insert.run('u3', 'user', 'three', 40);
}

describe('SessionRepository conversation rewind', () => {
  let db: BetterSqlite3.Database;
  let repository: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, noopLogger);
    applySessionsMigrations(db, noopLogger);
    applyIndexes(db);
    seed(db);
    repository = new SessionRepository(db);
  });

  afterEach(() => db.close());

  it('soft-hides the stable suffix and writes an auditable idempotency record', () => {
    const result = repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'rewind-request-1',
      createdAt: 100,
      ownerUserId: null,
    });

    expect(result.hiddenMessageIds).toEqual(['u2', 'a2', 'u3']);
    expect(db.prepare(`
      SELECT id, visibility, hidden_by_rewind_id
      FROM messages WHERE session_id = 'session-1' ORDER BY rowid
    `).all()).toEqual([
      { id: 'u1', visibility: 'active', hidden_by_rewind_id: null },
      { id: 'a1', visibility: 'active', hidden_by_rewind_id: null },
      { id: 'u2', visibility: 'rewound', hidden_by_rewind_id: result.rewindId },
      { id: 'a2', visibility: 'rewound', hidden_by_rewind_id: result.rewindId },
      { id: 'u3', visibility: 'rewound', hidden_by_rewind_id: result.rewindId },
    ]);
    expect(db.prepare(`
      SELECT idempotency_key, status, files_restored, files_deleted
      FROM session_rewinds WHERE id = ?
    `).get(result.rewindId)).toEqual({
      idempotency_key: 'rewind-request-1',
      status: 'completed',
      files_restored: 0,
      files_deleted: 0,
    });
  });

  it('returns the same rewind for a repeated idempotency key', () => {
    const first = repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'rewind-request-1',
      createdAt: 100,
      ownerUserId: null,
    });
    const changesAfterFirst = totalChanges(db);
    const second = repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'rewind-request-1',
      createdAt: 200,
      ownerUserId: null,
    });

    expect(second).toEqual(first);
    expect(totalChanges(db)).toBe(changesAfterFirst);
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_rewinds').get()).toEqual({ count: 1 });
  });

  it('rejects an invalid or already hidden anchor with zero writes', () => {
    const beforeMissing = totalChanges(db);
    expect(() => repository.applyPromptRewind('session-1', 'missing', {
      idempotencyKey: 'missing',
      ownerUserId: null,
    })).toThrow('Active user message not found');
    expect(totalChanges(db)).toBe(beforeMissing);

    repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'first',
      createdAt: 100,
      ownerUserId: null,
    });
    const beforeHidden = totalChanges(db);
    expect(() => repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'different',
      createdAt: 200,
      ownerUserId: null,
    })).toThrow('Active user message not found');
    expect(totalChanges(db)).toBe(beforeHidden);
  });

  it('rolls the visibility update back when the audit insert fails', () => {
    db.exec(`
      CREATE TRIGGER fail_rewind_audit
      BEFORE INSERT ON session_rewinds
      BEGIN
        SELECT RAISE(ABORT, 'injected rewind audit failure');
      END
    `);

    expect(() => repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'rewind-request-1',
      createdAt: 100,
      ownerUserId: null,
    })).toThrow('injected rewind audit failure');
    expect(db.prepare(`
      SELECT id, visibility FROM messages WHERE session_id = 'session-1' ORDER BY rowid
    `).all()).toEqual([
      { id: 'u1', visibility: 'active' },
      { id: 'a1', visibility: 'active' },
      { id: 'u2', visibility: 'active' },
      { id: 'a2', visibility: 'active' },
      { id: 'u3', visibility: 'active' },
    ]);
  });

  it('restores a rewind without deleting history and records the recovery', () => {
    db.prepare(`
      INSERT INTO generative_ui_instances (
        instance_id, session_id, source_message_id, source_ordinal, source_key,
        spec_hash, spec_json, state_json, state_revision, status,
        hidden_by_rewind_id, created_at, updated_at
      ) VALUES (
        'ui-active', 'session-1', 'a2', 0, 'active-source',
        'active-hash', '{}', '{}', 0, 'active', NULL, 40, 40
      )
    `).run();
    db.prepare(`
      INSERT INTO generative_ui_instances (
        instance_id, session_id, source_message_id, source_ordinal, source_key,
        spec_hash, spec_json, state_json, state_revision, status,
        hidden_by_rewind_id, created_at, updated_at
      ) VALUES (
        'ui-already-hidden', 'session-1', 'a2', 1, 'hidden-source',
        'hidden-hash', '{}', '{}', 0, 'hidden', NULL, 40, 40
      )
    `).run();
    const rewind = repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'rewind-request-1',
      createdAt: 100,
      ownerUserId: null,
    });
    expect(db.prepare(`
      SELECT status, hidden_by_rewind_id
      FROM generative_ui_instances
      WHERE instance_id = 'ui-active'
    `).get()).toEqual({
      status: 'hidden',
      hidden_by_rewind_id: rewind.rewindId,
    });

    const restored = repository.restorePromptRewind('session-1', rewind.rewindId, 200, null);

    expect(restored.restoredMessageCount).toBe(3);
    expect(repository.getMessages('session-1')).toHaveLength(5);
    expect(db.prepare(`
      SELECT status, restored_at FROM session_rewinds WHERE id = ?
    `).get(rewind.rewindId)).toEqual({ status: 'restored', restored_at: 200 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('session-1'))
      .toEqual({ count: 5 });
    expect(db.prepare(`
      SELECT instance_id, status, hidden_by_rewind_id, updated_at
      FROM generative_ui_instances
      WHERE instance_id IN ('ui-active', 'ui-already-hidden')
      ORDER BY instance_id
    `).all()).toEqual([
      {
        instance_id: 'ui-active',
        status: 'active',
        hidden_by_rewind_id: null,
        updated_at: 200,
      },
      {
        instance_id: 'ui-already-hidden',
        status: 'hidden',
        hidden_by_rewind_id: null,
        updated_at: 40,
      },
    ]);
  });

  it('uses the public timestamp-rowid order for the suffix even when timestamps arrive out of order', () => {
    db.prepare("UPDATE messages SET timestamp = 50 WHERE id = 'a1'").run();
    db.prepare("UPDATE messages SET timestamp = 5 WHERE id = 'u3'").run();

    const rewind = repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'out-of-order',
      createdAt: 100,
      ownerUserId: null,
    });

    expect(rewind.hiddenMessageIds).toEqual(['u2', 'a2', 'a1']);
    expect(rewind.activeMessages.map((message) => message.id)).toEqual(['u3', 'u1']);
  });

  it.each(['running', 'paused', 'queued', 'cancelling'])(
    'rejects persisted %s state in the transaction with zero writes',
    (status) => {
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, 'session-1');
      const before = totalChanges(db);

      expect(() => repository.applyPromptRewind('session-1', 'u2', {
        idempotencyKey: `persisted-${status}`,
        ownerUserId: null,
      })).toThrow('SESSION_RUNNING');
      expect(totalChanges(db)).toBe(before);
      expect(db.prepare('SELECT COUNT(*) AS count FROM session_rewinds').get()).toEqual({ count: 0 });
    },
  );

  it('rejects an active durable run even when the session projection says idle', () => {
    db.exec(`
      CREATE TABLE durable_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_run_id TEXT,
        status TEXT NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO durable_runs (run_id, session_id, parent_run_id, status)
      VALUES ('run-1', 'session-1', NULL, 'recovering')
    `).run();
    const before = totalChanges(db);

    expect(() => repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'durable-running',
      ownerUserId: null,
    })).toThrow('SESSION_RUNNING');
    expect(totalChanges(db)).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_rewinds').get()).toEqual({ count: 0 });
  });

  it('requires exact owner identity and rejects both another owner and anonymous mismatch with zero writes', () => {
    db.prepare("UPDATE sessions SET user_id = 'owner-a' WHERE id = 'session-1'").run();

    for (const ownerUserId of ['owner-b', null] as const) {
      const before = totalChanges(db);
      expect(() => repository.applyPromptRewind('session-1', 'u2', {
        idempotencyKey: `owner-${String(ownerUserId)}`,
        ownerUserId,
      })).toThrow('SESSION_ACCESS_DENIED');
      expect(totalChanges(db)).toBe(before);
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_rewinds').get()).toEqual({ count: 0 });
  });

  it('rejects a missing owner boundary with zero writes', () => {
    const before = totalChanges(db);

    expect(() => repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'missing-owner',
    })).toThrow('SESSION_ACCESS_DENIED');
    expect(totalChanges(db)).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_rewinds').get()).toEqual({ count: 0 });
  });

  it('restores nested rewinds only in LIFO order', () => {
    const older = repository.applyPromptRewind('session-1', 'u3', {
      idempotencyKey: 'older',
      createdAt: 100,
      ownerUserId: null,
    });
    const newer = repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'newer',
      createdAt: 100,
      ownerUserId: null,
    });
    const beforeOutOfOrderRestore = totalChanges(db);

    expect(() => repository.restorePromptRewind('session-1', older.rewindId, 200, null))
      .toThrow('REWIND_RESTORE_ORDER');
    expect(totalChanges(db)).toBe(beforeOutOfOrderRestore);
    expect(repository.getMessages('session-1').map((message) => message.id)).toEqual(['u1', 'a1']);

    repository.restorePromptRewind('session-1', newer.rewindId, 210, null);
    expect(repository.getMessages('session-1').map((message) => message.id))
      .toEqual(['u1', 'a1', 'u2', 'a2']);

    repository.restorePromptRewind('session-1', older.rewindId, 220, null);
    expect(repository.getMessages('session-1').map((message) => message.id))
      .toEqual(['u1', 'a1', 'u2', 'a2', 'u3']);
  });

  it('guards restore by owner and active persisted state before changing visibility', () => {
    db.prepare("UPDATE sessions SET user_id = 'owner-a' WHERE id = 'session-1'").run();
    const rewind = repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'restore-guard',
      createdAt: 100,
      ownerUserId: 'owner-a',
    });

    const beforeOwnerMismatch = totalChanges(db);
    expect(() => repository.restorePromptRewind('session-1', rewind.rewindId, 200, 'owner-b'))
      .toThrow('SESSION_ACCESS_DENIED');
    expect(totalChanges(db)).toBe(beforeOwnerMismatch);

    db.prepare("UPDATE sessions SET status = 'running' WHERE id = 'session-1'").run();
    const beforeRunning = totalChanges(db);
    expect(() => repository.restorePromptRewind('session-1', rewind.rewindId, 210, 'owner-a'))
      .toThrow('SESSION_RUNNING');
    expect(totalChanges(db)).toBe(beforeRunning);
  });
});

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
    });
    const changesAfterFirst = db.totalChanges;
    const second = repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'rewind-request-1',
      createdAt: 200,
    });

    expect(second).toEqual(first);
    expect(db.totalChanges).toBe(changesAfterFirst);
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_rewinds').get()).toEqual({ count: 1 });
  });

  it('rejects an invalid or already hidden anchor with zero writes', () => {
    const beforeMissing = db.totalChanges;
    expect(() => repository.applyPromptRewind('session-1', 'missing', {
      idempotencyKey: 'missing',
    })).toThrow('Active user message not found');
    expect(db.totalChanges).toBe(beforeMissing);

    repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'first',
      createdAt: 100,
    });
    const beforeHidden = db.totalChanges;
    expect(() => repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'different',
      createdAt: 200,
    })).toThrow('Active user message not found');
    expect(db.totalChanges).toBe(beforeHidden);
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
    const rewind = repository.applyPromptRewind('session-1', 'u2', {
      idempotencyKey: 'rewind-request-1',
      createdAt: 100,
    });

    const restored = repository.restorePromptRewind('session-1', rewind.rewindId, 200);

    expect(restored.restoredMessageCount).toBe(3);
    expect(repository.getMessages('session-1')).toHaveLength(5);
    expect(db.prepare(`
      SELECT status, restored_at FROM session_rewinds WHERE id = ?
    `).get(rewind.rewindId)).toEqual({ status: 'restored', restored_at: 200 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('session-1'))
      .toEqual({ count: 5 });
  });
});

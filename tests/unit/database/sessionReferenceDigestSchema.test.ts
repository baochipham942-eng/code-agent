import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';

describe('session reference digest schema', () => {
  it('persists one digest per session and removes it with the session', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    db.prepare(`
      INSERT INTO sessions (
        id, title, model_provider, model_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('session-1', 'History', 'openai', 'gpt-test', 1, 1);
    db.prepare(`
      INSERT INTO session_reference_digests (
        session_id, message_count, content_hash, digest, topics, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('session-1', 11, 'hash-1', 'digest', 'topic', 2);

    expect(db.prepare('SELECT COUNT(*) AS count FROM session_reference_digests').get()).toEqual({ count: 1 });

    db.prepare('DELETE FROM sessions WHERE id = ?').run('session-1');
    expect(db.prepare('SELECT COUNT(*) AS count FROM session_reference_digests').get()).toEqual({ count: 0 });
    db.close();
  });
});

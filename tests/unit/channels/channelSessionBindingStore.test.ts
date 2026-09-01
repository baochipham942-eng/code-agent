import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { ChannelSessionBindingStore } from '../../../src/host/channels/channelSessionBindingStore';
import { applySchema } from '../../../src/host/services/core/database/schema';

describe('ChannelSessionBindingStore', () => {
  let db: BetterSqlite3.Database | undefined;

  afterEach(() => db?.close());

  it('persists thread-aware bindings and cascades them when a session is deleted', () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, title, model_provider, model_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertSession.run('session-1', 'Thread 1', 'openai', 'gpt-test', 1, 1);
    insertSession.run('session-2', 'Thread 2', 'openai', 'gpt-test', 1, 1);
    const store = new ChannelSessionBindingStore(() => db ?? null);
    const threadOne = {
      accountId: 'account-1',
      chatId: 'chat-1',
      threadId: 'thread-1',
      ingressAuth: 'paired',
    };
    const threadTwo = { ...threadOne, threadId: 'thread-2' };

    store.set(threadOne, 'session-1');
    store.set(threadTwo, 'session-2');

    expect(store.get(threadOne)).toBe('session-1');
    expect(store.get(threadTwo)).toBe('session-2');

    db.prepare('DELETE FROM sessions WHERE id = ?').run('session-1');
    expect(store.get(threadOne)).toBeUndefined();
    expect(store.get(threadTwo)).toBe('session-2');
  });
});

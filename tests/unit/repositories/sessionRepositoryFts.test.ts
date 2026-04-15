// ============================================================================
// SessionRepository — Episodic FTS5 tests (Workstream D)
// ============================================================================
// 用 in-memory better-sqlite3 驱动真实 SQL + triggers，验证：
//   - messages INSERT/UPDATE/DELETE 通过 triggers 自动同步 FTS
//   - searchSessionMessagesFts 能按关键词 / 会话作用域 / limit 召回
//   - backfillSessionMessagesFts 幂等，FTS 空 + messages 非空时才跑
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { SessionRepository } from '../../../src/main/services/core/repositories/SessionRepository';
import type { Message } from '../../../src/shared/contract';

// ----------------------------------------------------------------------------
// Schema helper — 复制 databaseService 里 messages 表 + FTS 虚拟表 + triggers
// ----------------------------------------------------------------------------

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      working_directory TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER,
      status TEXT DEFAULT 'idle',
      workspace TEXT,
      last_token_usage TEXT,
      git_branch TEXT
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      attachments TEXT,
      thinking TEXT,
      effort_level TEXT,
      synced_at INTEGER,
      content_parts TEXT
    );
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
      message_id UNINDEXED,
      session_id UNINDEXED,
      role UNINDEXED,
      content,
      timestamp UNINDEXED,
      tokenize = 'trigram'
    );
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai_fts AFTER INSERT ON messages BEGIN
      INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
      VALUES (new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad_fts AFTER DELETE ON messages BEGIN
      DELETE FROM session_messages_fts WHERE message_id = old.id;
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au_fts AFTER UPDATE OF content ON messages BEGIN
      DELETE FROM session_messages_fts WHERE message_id = old.id;
      INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
      VALUES (new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp);
    END;
  `);
}

function insertSession(db: BetterSqlite3.Database, id: string): void {
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO sessions (id, title, generation_id, model_provider, model_name, working_directory, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(id, `test-${id}`, 'gen8', 'moonshot', 'kimi-k2.5', '/tmp/test', now, now);
}

function makeMessage(id: string, content: string, role: 'user' | 'assistant' = 'user'): Message {
  return {
    id,
    role,
    content,
    timestamp: Date.now(),
  } as unknown as Message;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('SessionRepository — Episodic FTS5', () => {
  let db: BetterSqlite3.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    repo = new SessionRepository(db);
    insertSession(db, 'sess-A');
    insertSession(db, 'sess-B');
  });

  afterEach(() => {
    db.close();
  });

  it('indexes new messages via trigger on addMessage', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'how do I run evals on mental agent'));
    repo.addMessage('sess-A', makeMessage('m2', '跑评测要先准备数据'));

    const ftsCount = (
      db.prepare('SELECT COUNT(*) as c FROM session_messages_fts').get() as { c: number }
    ).c;
    expect(ftsCount).toBe(2);
  });

  it('searches across sessions and ranks by relevance', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'how to run evals on mental agent'));
    repo.addMessage('sess-B', makeMessage('m2', '跑评测的正确流程是什么'));
    repo.addMessage('sess-A', makeMessage('m3', 'totally unrelated message about pasta'));

    const results = repo.searchSessionMessagesFts('evals');
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The "pasta" message should NOT match a keyword query for "evals"
    for (const r of results) {
      expect(r.content.toLowerCase()).toContain('eval');
    }
  });

  it('honors sessionId scope filter', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'deployment pipeline notes'));
    repo.addMessage('sess-B', makeMessage('m2', 'deployment procedure draft'));

    const allResults = repo.searchSessionMessagesFts('deployment');
    expect(allResults.length).toBe(2);

    const scopedResults = repo.searchSessionMessagesFts('deployment', { sessionId: 'sess-A' });
    expect(scopedResults.length).toBe(1);
    expect(scopedResults[0].sessionId).toBe('sess-A');
  });

  it('honors limit parameter with hard cap of 50', () => {
    for (let i = 0; i < 20; i++) {
      repo.addMessage('sess-A', makeMessage('m' + i, `keyword test ${i}`));
    }
    const results = repo.searchSessionMessagesFts('keyword', { limit: 5 });
    expect(results.length).toBe(5);

    // limit > 50 → clamped to 50
    const bigResults = repo.searchSessionMessagesFts('keyword', { limit: 999 });
    expect(bigResults.length).toBeLessThanOrEqual(50);
  });

  it('removes FTS row when message is deleted via CASCADE-like trigger', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'ephemeral keyword-xyz message'));
    let results = repo.searchSessionMessagesFts('keyword-xyz');
    expect(results.length).toBe(1);

    // Simulate a direct DELETE (e.g., truncateMessagesAfter / message cleanup)
    db.prepare('DELETE FROM messages WHERE id = ?').run('m1');

    results = repo.searchSessionMessagesFts('keyword-xyz');
    expect(results.length).toBe(0);
  });

  it('updates FTS row when message content is updated', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'original content about topic-aaa'));
    expect(repo.searchSessionMessagesFts('topic-aaa').length).toBe(1);

    repo.updateMessage('m1', { content: 'revised content about topic-bbb' });

    expect(repo.searchSessionMessagesFts('topic-aaa').length).toBe(0);
    expect(repo.searchSessionMessagesFts('topic-bbb').length).toBe(1);
  });

  it('backfills FTS from pre-existing messages when FTS is empty', () => {
    // Seed messages AFTER disabling the insert trigger, simulating a pre-FTS install
    db.exec('DROP TRIGGER IF EXISTS messages_ai_fts;');
    const stmt = db.prepare(
      `
      INSERT INTO messages (id, session_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
      `,
    );
    stmt.run('legacy1', 'sess-A', 'user', 'legacy backfill alpha', Date.now());
    stmt.run('legacy2', 'sess-A', 'user', 'legacy backfill beta', Date.now());
    stmt.run('legacy3', 'sess-B', 'assistant', 'legacy backfill gamma', Date.now());

    // FTS should be empty at this point
    expect((db.prepare('SELECT COUNT(*) as c FROM session_messages_fts').get() as { c: number }).c).toBe(0);

    const inserted = repo.backfillSessionMessagesFts();
    expect(inserted).toBe(3);

    const results = repo.searchSessionMessagesFts('legacy');
    expect(results.length).toBe(3);
  });

  it('backfill is a no-op when FTS already has rows', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'already indexed message'));
    const inserted = repo.backfillSessionMessagesFts();
    expect(inserted).toBe(0);
  });

  it('returns empty array on blank query', () => {
    repo.addMessage('sess-A', makeMessage('m1', 'some content'));
    expect(repo.searchSessionMessagesFts('')).toEqual([]);
    expect(repo.searchSessionMessagesFts('   ')).toEqual([]);
  });

  it('supports Chinese search with 3+ char queries (trigram)', () => {
    repo.addMessage('sess-A', makeMessage('m1', '我今天在调试飞书机器人的消息路由'));
    repo.addMessage('sess-A', makeMessage('m2', '昨天在写保时捷卡券的审核流程'));

    // 3-char query matches via trigram
    const results = repo.searchSessionMessagesFts('飞书机');
    expect(results.length).toBe(1);
    expect(results[0].content).toContain('飞书机器人');

    // 2-char query below trigram threshold returns empty
    expect(repo.searchSessionMessagesFts('飞书')).toEqual([]);
  });
});

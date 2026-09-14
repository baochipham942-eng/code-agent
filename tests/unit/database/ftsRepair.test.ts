import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import {
  getDisabledFtsTables,
  isFtsDisabled,
  isFtsSearchDegraded,
  repairCorruptFtsOnStartup,
  repairFtsTable,
  resetFtsRepairStateForTests,
} from '../../../src/host/services/core/database/ftsRepair';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import type { Message } from '../../../src/shared/contract';

function createSchema(db: BetterSqlite3.Database): void {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      responses_output TEXT,
      attachments TEXT,
      thinking TEXT,
      effort_level TEXT,
      synced_at INTEGER,
      content_parts TEXT,
      metadata TEXT,
      is_meta INTEGER NOT NULL DEFAULT 0,
      compaction TEXT,
      visibility TEXT NOT NULL DEFAULT 'active',
      hidden_by_rewind_id TEXT,
      hidden_at INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
      message_id UNINDEXED,
      session_id UNINDEXED,
      role UNINDEXED,
      content,
      timestamp UNINDEXED,
      tokenize = 'trigram'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai_fts AFTER INSERT ON messages BEGIN
      INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
      SELECT new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp
      WHERE COALESCE(new.is_meta, 0) = 0
        AND COALESCE(new.content, '') NOT LIKE '%【循环模式 · 第%轮】%'
        AND COALESCE(new.content, '') NOT LIKE '%[[LOOP_WAIT]]%';
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad_fts AFTER DELETE ON messages BEGIN
      DELETE FROM session_messages_fts WHERE message_id = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au_fts AFTER UPDATE OF content, is_meta ON messages BEGIN
      DELETE FROM session_messages_fts WHERE message_id = old.id;
      INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
      SELECT new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp
      WHERE COALESCE(new.is_meta, 0) = 0
        AND COALESCE(new.content, '') NOT LIKE '%【循环模式 · 第%轮】%'
        AND COALESCE(new.content, '') NOT LIKE '%[[LOOP_WAIT]]%';
    END;
  `);
}

function insertSession(db: BetterSqlite3.Database, id: string): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `test-${id}`, 'moonshot', 'kimi-k2.5', '/tmp/test', now, now);
}

function makeMessage(id: string, content: string, timestamp = Date.now()): Message {
  return { id, role: 'user', content, timestamp } as unknown as Message;
}

function seedMessages(repo: SessionRepository, count: number): void {
  for (let i = 0; i < count; i += 1) {
    repo.addMessage('sess-1', makeMessage(`m-${i}`, `hello world unique needle ${i} 验收关键词`, 1_000 + i));
  }
}

function corruptFtsShadowPages(
  dbPath: string,
  opts: { names?: string[]; leafOnly?: boolean } = {},
): void {
  const db = new Database(dbPath);
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const names = opts.names ?? ['session_messages_fts_data', 'session_messages_fts_idx'];
  const placeholders = names.map(() => '?').join(', ');
  let sql = `SELECT name, pageno, pagetype FROM dbstat WHERE name IN (${placeholders})`;
  if (opts.leafOnly) sql += ` AND pagetype = 'leaf'`;
  const pages = db.prepare(sql).all(...names) as Array<{ name: string; pageno: number; pagetype: string }>;
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();

  const buf = fs.readFileSync(dbPath);
  for (const page of pages) {
    if (page.pageno <= 1) continue;
    const offset = (page.pageno - 1) * pageSize;
    for (let i = 16; i < 80 && offset + i < buf.length; i += 1) {
      buf[offset + i] ^= 0xff;
    }
  }
  fs.writeFileSync(dbPath, buf);
}

function openRepo(dbPath: string): { db: BetterSqlite3.Database; repo: SessionRepository } {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return { db, repo: new SessionRepository(db) };
}

describe('ftsRepair ladder', () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetFtsRepairStateForTests();
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-fts-repair-'));
    dirs.push(dir);
    return path.join(dir, 'code-agent.db');
  }

  it('rebuilds from source after leaf data/idx corruption: addMessage works and MATCH recall returns', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 50);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: true });

    ({ db, repo } = openRepo(dbPath));
    expect(() => repo.addMessage('sess-1', makeMessage('m-new', 'post-repair needle extra', 2_000))).not.toThrow();
    const hits = repo.searchSessionMessagesFts('needle', { limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.messageId === 'm-new' || hit.content.includes('post-repair'))).toBe(true);
    expect(isFtsDisabled('session_messages_fts')).toBe(false);
    db.close();
  });

  it('keeps addMessage alive when data/idx internal pages are corrupt (write trigger SQLITE_CORRUPT)', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 50);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: false });

    ({ db, repo } = openRepo(dbPath));
    expect(() => repo.addMessage('sess-1', makeMessage('m-write', 'write-path needle after corrupt', 2_100))).not.toThrow();
    const hits = repo.searchSessionMessagesFts('needle', { limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.messageId === 'm-write')).toBe(true);
    db.close();
  });

  it('replaceMessages survives FTS shadow-page corruption: repair runs outside the transaction and retry applies the replacement', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 50);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: false });

    ({ db, repo } = openRepo(dbPath));
    const replacement = [
      makeMessage('m-r0', 'replacement needle alpha', 9_000),
      makeMessage('m-r1', 'replacement needle beta', 9_001),
    ];
    expect(() => repo.replaceMessages('sess-1', replacement, 9_100)).not.toThrow();

    const rows = db.prepare(`
      SELECT id
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, rowid ASC
    `).all('sess-1') as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(['m-r0', 'm-r1']);
    expect(isFtsDisabled('session_messages_fts')).toBe(false);
    const hits = repo.searchSessionMessagesFts('replacement needle', { limit: 10 });
    expect(hits.some((hit) => hit.messageId === 'm-r0')).toBe(true);
    expect(hits.some((hit) => hit.messageId === 'm-r1')).toBe(true);
    db.close();
  });

  it('drop+recreates an empty table when rebuild is injected to fail, and LIKE still recalls', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 20);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: true });
    ({ db, repo } = openRepo(dbPath));

    const outcome = repairFtsTable(db, 'session_messages_fts', {
      rebuild: () => {
        throw new Error('injected rebuild failure');
      },
    });
    expect(outcome).toBe('empty-recreated');
    expect(isFtsSearchDegraded('session_messages_fts')).toBe(true);

    expect(() => repo.addMessage('sess-1', makeMessage('m-empty', 'after empty recreate', 3_000))).not.toThrow();
    const hits = repo.searchSessionMessagesFts('needle', { limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    db.close();
  });

  it('disables FTS writes and uses LIKE when drop/create is also injected to fail', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 20);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: true });
    ({ db, repo } = openRepo(dbPath));

    const outcome = repairFtsTable(db, 'session_messages_fts', {
      rebuild: () => {
        throw new Error('injected rebuild failure');
      },
      recreateEmpty: () => {
        throw new Error('injected recreate failure');
      },
    });
    expect(outcome).toBe('disabled');
    expect(isFtsDisabled('session_messages_fts')).toBe(true);
    expect(getDisabledFtsTables()).toEqual(['session_messages_fts']);

    expect(() => repo.addMessage('sess-1', makeMessage('m-disabled', 'after disable needle', 4_000))).not.toThrow();
    const hits = repo.searchSessionMessagesFts('needle', { limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.messageId === 'm-disabled')).toBe(true);
    db.close();
  });

  it('FTS disabled: empty query returns no hits and zero count, non-empty LIKE query still recalls', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 20);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: true });
    ({ db, repo } = openRepo(dbPath));

    const outcome = repairFtsTable(db, 'session_messages_fts', {
      rebuild: () => {
        throw new Error('injected rebuild failure');
      },
      recreateEmpty: () => {
        throw new Error('injected recreate failure');
      },
    });
    expect(outcome).toBe('disabled');
    expect(isFtsSearchDegraded('session_messages_fts')).toBe(true);

    // 空查询不许退化成 LIKE '%%' 全库搜索
    expect(repo.searchSessionMessagesFts('', { limit: 50 })).toEqual([]);
    expect(repo.searchSessionMessagesFts('   ', { limit: 50 })).toEqual([]);
    expect(repo.countSessionMessagesFts('')).toEqual({ matches: 0, sessions: 0 });
    expect(repo.countSessionMessagesFts('   ')).toEqual({ matches: 0, sessions: 0 });

    // 非空查询仍走 LIKE 兜底，有召回
    const hits = repo.searchSessionMessagesFts('needle', { limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    const count = repo.countSessionMessagesFts('needle');
    expect(count.matches).toBeGreaterThan(0);
    db.close();
  });

  it('updateMessage survives FTS shadow-page corruption: write repair wrapper retries the update', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 50);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: false });
    ({ db, repo } = openRepo(dbPath));

    expect(() => repo.updateMessage('m-3', { content: 'updated needle after corrupt' }, 'sess-1')).not.toThrow();
    const row = db.prepare('SELECT content FROM messages WHERE id = ?').get('m-3') as { content: string };
    expect(row.content).toBe('updated needle after corrupt');
    expect(isFtsDisabled('session_messages_fts')).toBe(false);
    const hits = repo.searchSessionMessagesFts('updated needle', { limit: 10 });
    expect(hits.some((hit) => hit.messageId === 'm-3')).toBe(true);
    db.close();
  });

  it('startup maintenance does not throw after FTS shadow-page corruption', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 30);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: true });
    ({ db, repo } = openRepo(dbPath));
    expect(() => {
      repairCorruptFtsOnStartup(db);
      repo.backfillSessionMessagesFts();
    }).not.toThrow();
    expect(() => repo.addMessage('sess-1', makeMessage('m-init', 'init still writable needle', 5_000))).not.toThrow();
    db.close();
  });
});

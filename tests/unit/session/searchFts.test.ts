// ============================================================================
// searchSessions — FTS 主路径测试
// ============================================================================
// 用 in-memory better-sqlite3 + 真实 triggers 驱动 SessionRepository，
// 包装成 SessionSearchFtsSource 验证：
//   - 只存在于 DB、不在 LRU 缓存中的老会话能被搜到（上下文片段/高亮/轮次）
//   - 缓存命中路径（内存回落）结果与排序不退化
//   - 候选触顶时 totalMatches / truncated 用 FTS COUNT 反映全量
//   - 短查询 / caseSensitive / DB 未就绪时回落内存搜索
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import {
  searchSessions,
  type SessionSearchFtsSource,
} from '../../../src/host/session/search';
import { SessionLocalCache } from '../../../src/host/session/localCache';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { SESSION_SEARCH } from '../../../src/shared/constants';
import type { Message } from '../../../src/shared/contract';

// ----------------------------------------------------------------------------
// Schema helper — 与 tests/unit/repositories/sessionRepositoryFts.test.ts 同源：
// messages 表 + FTS 虚拟表 + 自动同步 triggers
// ----------------------------------------------------------------------------

function createSchema(db: BetterSqlite3.Database): void {
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
      content_parts TEXT,
      metadata TEXT,
      is_meta INTEGER NOT NULL DEFAULT 0,
      compaction TEXT,
      visibility TEXT NOT NULL DEFAULT 'active',
      hidden_by_rewind_id TEXT,
      hidden_at INTEGER
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_rewinds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      anchor_message_id TEXT NOT NULL,
      anchor_prompt TEXT NOT NULL,
      anchor_timestamp INTEGER NOT NULL,
      checkpoint_message_id TEXT,
      hidden_message_count INTEGER NOT NULL DEFAULT 0,
      hidden_message_ids TEXT,
      files_restored INTEGER NOT NULL DEFAULT 0,
      files_deleted INTEGER NOT NULL DEFAULT 0,
      errors_json TEXT,
      idempotency_key TEXT,
      request_digest TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      restored_at INTEGER,
      created_at INTEGER NOT NULL
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
      SELECT new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp
      WHERE COALESCE(new.is_meta, 0) = 0
        AND COALESCE(new.content, '') NOT LIKE '%【循环模式 · 第%轮】%'
        AND COALESCE(new.content, '') NOT LIKE '%[[LOOP_WAIT]]%';
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad_fts AFTER DELETE ON messages BEGIN
      DELETE FROM session_messages_fts WHERE message_id = old.id;
    END;
  `);
  db.exec(`
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
  db.prepare(
    `
    INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(id, `test-${id}`, 'moonshot', 'kimi-k2.5', '/tmp/test', now, now);
}

function makeMessage(
  id: string,
  content: string,
  role: 'user' | 'assistant' = 'user',
  timestamp = Date.now()
): Message {
  return { id, role, content, timestamp } as unknown as Message;
}

function createFtsSource(repo: SessionRepository): SessionSearchFtsSource {
  return {
    isReady: true,
    searchSessionMessagesFts: (query, options) => repo.searchSessionMessagesFts(query, options),
    countSessionMessagesFts: (query, options) => repo.countSessionMessagesFts(query, options),
    getMessages: (sessionId, limit) => repo.getMessages(sessionId, limit),
  };
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('searchSessions — FTS 主路径', () => {
  let db: BetterSqlite3.Database;
  let repo: SessionRepository;
  let ftsSource: SessionSearchFtsSource;
  let cache: SessionLocalCache;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    repo = new SessionRepository(db);
    ftsSource = createFtsSource(repo);
    cache = new SessionLocalCache();
  });

  afterEach(() => {
    db.close();
  });

  it('能搜到只存在于 DB、不在 LRU 缓存中的老会话', () => {
    insertSession(db, 'sess-old');
    repo.addMessage('sess-old', makeMessage('m1', '第一条任务', 'user', 1));
    repo.addMessage('sess-old', makeMessage('m2', '第一条回答', 'assistant', 2));
    repo.addMessage('sess-old', makeMessage('m3', '第二条任务', 'user', 3));
    repo.addMessage('sess-old', makeMessage('m4', '这里藏着历史会话的 needle 关键词', 'assistant', 4));

    const result = searchSessions('needle', {}, cache, ftsSource);

    expect(result.results).toHaveLength(1);
    expect(result.totalMatches).toBe(1);
    expect(result.sessionsWithMatches).toBe(1);
    expect(result.truncated).toBe(false);

    const hit = result.results[0];
    expect(hit.sessionId).toBe('sess-old');
    expect(hit.message.id).toBe('m4');
    expect(hit.messageIndex).toBe(3);
    expect(hit.turnNumber).toBe(2);
    expect(hit.matches[0].start).toBeGreaterThanOrEqual(0);
    expect(hit.matches[0].context).toContain('needle');
    // 命中高亮（** 标记）与上下文片段保持现有 UI 契约
    expect(hit.snippet).toContain('**needle**');
  });

  it('FTS 结果回填进缓存后，二次搜索走同一形状', () => {
    insertSession(db, 'sess-rehydrate');
    repo.addMessage('sess-rehydrate', makeMessage('m1', '重复检索的 needle 目标', 'user', 1));

    const first = searchSessions('needle', {}, cache, ftsSource);
    expect(first.results).toHaveLength(1);
    expect(cache.getSession('sess-rehydrate')).toBeDefined();

    const second = searchSessions('needle', {}, cache, ftsSource);
    expect(second.results[0].message.id).toBe('m1');
    expect(second.results[0].relevance).toBe(first.results[0].relevance);
  });

  it('缓存命中路径的搜索结果与排序不退化（FTS 与内存结果一致）', () => {
    insertSession(db, 'sess-A');
    repo.addMessage('sess-A', makeMessage('a1', 'needle 出现在开头，needle 重复一次', 'user', 10));
    repo.addMessage('sess-A', makeMessage('a2', '无关内容', 'assistant', 20));
    repo.addMessage('sess-A', makeMessage('a3', 'needle 只在末尾出现一次，前面都是很长的无关铺垫内容', 'assistant', 30));
    insertSession(db, 'sess-B');
    repo.addMessage('sess-B', makeMessage('b1', '另一个会话的 needle', 'user', 40));

    // 两个会话都进缓存（模拟 hydrateCrossSessionSearchCache 后的状态）
    cache.setSession({
      sessionId: 'sess-A',
      startedAt: 10,
      lastActivityAt: 30,
      totalTokens: 0,
      messages: [
        { id: 'a1', role: 'user', content: 'needle 出现在开头，needle 重复一次', timestamp: 10 },
        { id: 'a2', role: 'assistant', content: '无关内容', timestamp: 20 },
        { id: 'a3', role: 'assistant', content: 'needle 只在末尾出现一次，前面都是很长的无关铺垫内容', timestamp: 30 },
      ],
    });
    cache.setSession({
      sessionId: 'sess-B',
      startedAt: 40,
      lastActivityAt: 40,
      totalTokens: 0,
      messages: [
        { id: 'b1', role: 'user', content: '另一个会话的 needle', timestamp: 40 },
      ],
    });

    const memoryResult = searchSessions('needle', {}, cache);
    const ftsResult = searchSessions('needle', {}, cache, ftsSource);

    expect(ftsResult.totalMatches).toBe(memoryResult.totalMatches);
    expect(ftsResult.sessionsWithMatches).toBe(memoryResult.sessionsWithMatches);
    expect(ftsResult.truncated).toBe(memoryResult.truncated);
    expect(
      ftsResult.results.map((r) => ({ id: r.message.id, relevance: r.relevance, snippet: r.snippet }))
    ).toEqual(
      memoryResult.results.map((r) => ({ id: r.message.id, relevance: r.relevance, snippet: r.snippet }))
    );
  });

  it('候选触顶时 totalMatches / truncated 反映全量（FTS COUNT）', () => {
    insertSession(db, 'sess-bulk');
    const extraBeyondCap = 20;
    const total = SESSION_SEARCH.FTS_CANDIDATE_LIMIT + extraBeyondCap;
    for (let i = 0; i < total; i++) {
      repo.addMessage('sess-bulk', makeMessage(`bulk-${i}`, `bulkneedle 命中第 ${i} 条`, 'user', i + 1));
    }

    const result = searchSessions('bulkneedle', { limit: 30 }, cache, ftsSource);

    // 候选按 500 触顶截断，但计数必须反映全量 520
    expect(result.results).toHaveLength(30);
    expect(result.totalMatches).toBe(total);
    expect(result.sessionsWithMatches).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('命中消息超出回填窗口时兜底返回（messageIndex=-1，跳转走 messageId）', () => {
    insertSession(db, 'sess-long');
    const windowSize = SESSION_SEARCH.HYDRATE_MESSAGE_LIMIT;
    for (let i = 0; i < windowSize; i++) {
      repo.addMessage('sess-long', makeMessage(`pad-${i}`, `普通内容 ${i}`, 'user', i + 1));
    }
    // 第 windowSize+1 条：在 FTS 索引里，但不在前 windowSize 条回填窗口内
    repo.addMessage('sess-long', makeMessage('tail-hit', '窗口之外的 windowtail needle', 'user', windowSize + 1));

    const result = searchSessions('windowtail', {}, cache, ftsSource);

    expect(result.results).toHaveLength(1);
    const hit = result.results[0];
    expect(hit.message.id).toBe('tail-hit');
    expect(hit.messageIndex).toBe(-1);
    expect(hit.turnNumber).toBeUndefined();
    expect(hit.message.content).toContain('windowtail');
    expect(hit.snippet).toContain('**windowtail**');
  });

  it('role 过滤经 FTS 下推生效', () => {
    insertSession(db, 'sess-role');
    repo.addMessage('sess-role', makeMessage('u1', 'rolecheck needle 问题', 'user', 1));
    repo.addMessage('sess-role', makeMessage('a1', 'rolecheck needle 回答', 'assistant', 2));

    const assistantOnly = searchSessions('rolecheck', { role: 'assistant' }, cache, ftsSource);
    expect(assistantOnly.results.map((r) => r.message.id)).toEqual(['a1']);
    expect(assistantOnly.totalMatches).toBe(1);

    const userOnly = searchSessions('rolecheck', { role: 'user' }, cache, ftsSource);
    expect(userOnly.results.map((r) => r.message.id)).toEqual(['u1']);
  });

  it('sessionIds 作用域经 FTS 下推生效', () => {
    insertSession(db, 'sess-scope-A');
    insertSession(db, 'sess-scope-B');
    repo.addMessage('sess-scope-A', makeMessage('sa1', 'scopecheck needle from A', 'user', 1));
    repo.addMessage('sess-scope-B', makeMessage('sb1', 'scopecheck needle from B', 'user', 2));

    const scoped = searchSessions('scopecheck', { sessionIds: ['sess-scope-B'] }, cache, ftsSource);
    expect(scoped.results.map((r) => r.sessionId)).toEqual(['sess-scope-B']);
    expect(scoped.totalMatches).toBe(1);
  });

  it('短查询（低于 trigram 最小长度）回落内存搜索', () => {
    insertSession(db, 'sess-short-db');
    repo.addMessage('sess-short-db', makeMessage('d1', '包含 ab 的 DB 会话', 'user', 1));
    cache.setSession({
      sessionId: 'sess-short-cache',
      startedAt: 1,
      lastActivityAt: 1,
      totalTokens: 0,
      messages: [{ id: 'c1', role: 'user', content: '包含 ab 的缓存会话', timestamp: 1 }],
    });

    const result = searchSessions('ab', {}, cache, ftsSource);

    // 只命中缓存内会话；DB-only 会话不进入内存搜索范围
    expect(result.results.map((r) => r.sessionId)).toEqual(['sess-short-cache']);
  });

  it('caseSensitive 回落内存搜索', () => {
    insertSession(db, 'sess-case-db');
    repo.addMessage('sess-case-db', makeMessage('d1', 'db casecheck NEEDLE', 'user', 1));
    cache.setSession({
      sessionId: 'sess-case-cache',
      startedAt: 1,
      lastActivityAt: 1,
      totalTokens: 0,
      messages: [{ id: 'c1', role: 'user', content: 'cache casecheck NEEDLE', timestamp: 1 }],
    });

    const result = searchSessions('NEEDLE', { caseSensitive: true }, cache, ftsSource);

    expect(result.results.map((r) => r.sessionId)).toEqual(['sess-case-cache']);
  });

  it('DB 未就绪时回落内存搜索', () => {
    insertSession(db, 'sess-notready');
    repo.addMessage('sess-notready', makeMessage('d1', 'notready needle in db', 'user', 1));
    cache.setSession({
      sessionId: 'sess-notready-cache',
      startedAt: 1,
      lastActivityAt: 1,
      totalTokens: 0,
      messages: [{ id: 'c1', role: 'user', content: 'notready needle in cache', timestamp: 1 }],
    });

    const notReadySource: SessionSearchFtsSource = { ...ftsSource, isReady: false };
    const result = searchSessions('notready', {}, cache, notReadySource);

    expect(result.results.map((r) => r.sessionId)).toEqual(['sess-notready-cache']);
  });

  // 数据源是 IPC 层惰性注入的结构接口，运行时可能拿到只实现旧接口的
  // DatabaseService 子集（CLI / web 等形态）。缺方法必须回落而不是抛。
  it('数据源 isReady 但缺 FTS 方法时回落内存搜索，不抛异常', () => {
    insertSession(db, 'sess-partial');
    repo.addMessage('sess-partial', makeMessage('d1', 'partial needle in db', 'user', 1));
    cache.setSession({
      sessionId: 'sess-partial-cache',
      startedAt: 1,
      lastActivityAt: 1,
      totalTokens: 0,
      messages: [{ id: 'c1', role: 'user', content: 'partial needle in cache', timestamp: 1 }],
    });

    // 两个方法各缺一个单独成例，保证两条守卫都被独立钉住：
    // 只写一个「两者都缺」的用例时，摘掉任一守卫另一条仍会拦住，变异验证不转红。
    const missingSearch = {
      isReady: true,
      countSessionMessagesFts: ftsSource.countSessionMessagesFts,
    } as unknown as SessionSearchFtsSource;
    const missingCount = {
      isReady: true,
      searchSessionMessagesFts: ftsSource.searchSessionMessagesFts,
    } as unknown as SessionSearchFtsSource;

    for (const source of [missingSearch, missingCount]) {
      expect(() => searchSessions('partial', {}, cache, source)).not.toThrow();
      expect(searchSessions('partial', {}, cache, source).results.map((r) => r.sessionId))
        .toEqual(['sess-partial-cache']);
    }
  });
});

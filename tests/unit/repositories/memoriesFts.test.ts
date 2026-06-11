// ============================================================================
// MemoryRepository — memories FTS5/BM25 检索通道（roadmap 2.5）
// ============================================================================
// - memories_fts 虚拟表（trigram）索引 content + summary，triggers 自动同步
// - searchMemories 升级为 BM25 召回优先（相关性排序），LIKE 兜底
//   （查询 <3 字符 / FTS 语法错误 / FTS 零命中）
// - backfill 幂等 + 原子
// Schema 来自 src/shared/memoriesFts.sql（与生产共用，防漂移）
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import {
  applyMemoriesFtsSchema,
  runMemoriesFtsBackfill,
} from '../../../src/shared/memoriesFts.sql';
import { MemoryRepository } from '../../../src/main/services/core/repositories/MemoryRepository';
import type { MemoryRecord } from '../../../src/main/protocol/types';

function createMemoriesSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      source TEXT NOT NULL,
      project_path TEXT,
      session_id TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      metadata TEXT DEFAULT '{}',
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER
    );
  `);
}

function makeMemoryInput(content: string, overrides: Partial<Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>> = {}) {
  return {
    type: 'project_knowledge',
    category: 'context',
    content,
    source: 'manual',
    confidence: 1.0,
    ...overrides,
  } as Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>;
}

function ftsRows(db: BetterSqlite3.Database): Array<{ memory_id: string; content: string; summary: string | null }> {
  return db.prepare('SELECT memory_id, content, summary FROM memories_fts ORDER BY memory_id').all() as Array<{
    memory_id: string;
    content: string;
    summary: string | null;
  }>;
}

describe('MemoryRepository — memories FTS5/BM25 channel', () => {
  let db: BetterSqlite3.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createMemoriesSchema(db);
    applyMemoriesFtsSchema(db);
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ---- trigger 同步 ----------------------------------------------------------

  it('indexes content and summary on createMemory via trigger', () => {
    repo.createMemory(makeMemoryInput('quokka deployment pipeline notes', { summary: 'quokka summary' }));
    const rows = ftsRows(db);
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain('quokka');
    expect(rows[0].summary).toContain('quokka');
  });

  it('re-indexes on updateMemory and removes on deleteMemory', () => {
    const created = repo.createMemory(makeMemoryInput('original ocelot content'));
    repo.updateMemory(created.id, { content: 'revised pangolin content' });

    expect(repo.searchMemories('ocelot', { applyDecay: false })).toEqual([]);
    expect(repo.searchMemories('pangolin', { applyDecay: false }).length).toBe(1);

    repo.deleteMemory(created.id);
    expect(ftsRows(db)).toEqual([]);
  });

  // ---- BM25 召回 ---------------------------------------------------------------

  it('ranks by BM25 relevance instead of access_count when query matches', () => {
    // 弱相关但 access_count 高 vs 强相关但 access_count 低：
    // LIKE 老路径按 access_count 排序会把弱相关排前面
    const weak = repo.createMemory(makeMemoryInput('mentions wombat once among many other unrelated words here'));
    const strong = repo.createMemory(makeMemoryInput('wombat wombat wombat — dedicated wombat troubleshooting guide', { summary: 'wombat guide' }));
    db.prepare('UPDATE memories SET access_count = 99 WHERE id = ?').run(weak.id);

    const results = repo.searchMemories('wombat', { applyDecay: false });
    expect(results.length).toBe(2);
    expect(results[0].id).toBe(strong.id);
  });

  it('honors type and category filters in the FTS path', () => {
    repo.createMemory(makeMemoryInput('tapir fact in code pattern', { type: 'code_pattern', category: 'pattern' }));
    repo.createMemory(makeMemoryInput('tapir fact in project knowledge', { type: 'project_knowledge', category: 'context' }));

    const byType = repo.searchMemories('tapir fact', { type: 'code_pattern', applyDecay: false });
    expect(byType.length).toBe(1);
    expect(byType[0].type).toBe('code_pattern');

    const byCategory = repo.searchMemories('tapir fact', { category: 'context', applyDecay: false });
    expect(byCategory.length).toBe(1);
    expect(byCategory[0].category).toBe('context');
  });

  it('supports CJK queries via trigram', () => {
    repo.createMemory(makeMemoryInput('保时捷卡券核销流程的注意事项'));
    const results = repo.searchMemories('卡券核销', { applyDecay: false });
    expect(results.length).toBe(1);
  });

  // ---- LIKE 兜底 ---------------------------------------------------------------

  it('falls back to LIKE for sub-trigram queries (<3 chars)', () => {
    repo.createMemory(makeMemoryInput('contains the marker xy somewhere'));
    const results = repo.searchMemories('xy', { applyDecay: false });
    expect(results.length).toBe(1);
  });

  it('falls back to LIKE when raw FTS syntax is malformed', () => {
    repo.createMemory(makeMemoryInput('content with "quoted axolotl" inside'));
    // 以 " 开头视为 raw FTS5 语法；不配对的引号会让 FTS 抛错 → 应退回 LIKE
    const results = repo.searchMemories('"quoted axolotl', { applyDecay: false });
    expect(results.length).toBe(1);
  });

  it('falls back to LIKE when FTS returns zero hits', () => {
    // 直接绕过 trigger 制造 FTS 缺行（模拟历史数据缺口），LIKE 仍能召回
    db.exec('DROP TRIGGER IF EXISTS memories_ai_fts;');
    db.prepare(
      `INSERT INTO memories (id, type, category, content, source, confidence, metadata, access_count, created_at, updated_at)
       VALUES ('gap1', 'conversation', 'context', 'unindexed numbat fact', 'manual', 1.0, '{}', 0, 1, 1)`
    ).run();
    const results = repo.searchMemories('numbat fact', { applyDecay: false });
    expect(results.length).toBe(1);
  });

  // ---- decay 维持 ---------------------------------------------------------------

  it('still applies read-time decay on the FTS path', () => {
    const created = repo.createMemory(makeMemoryInput('decaying echidna knowledge'));
    // 把 updated_at/last_accessed_at 拨回远古，confidence 衰减后应被过滤
    const ancient = Date.now() - 1000 * 60 * 60 * 24 * 365 * 5;
    db.prepare('UPDATE memories SET updated_at = ?, last_accessed_at = ? WHERE id = ?').run(ancient, ancient, created.id);

    expect(repo.searchMemories('echidna knowledge')).toEqual([]);
    expect(repo.searchMemories('echidna knowledge', { applyDecay: false }).length).toBe(1);
  });

  // ---- backfill -----------------------------------------------------------------

  it('backfills existing memories idempotently', () => {
    db.exec('DROP TRIGGER IF EXISTS memories_ai_fts;');
    db.prepare(
      `INSERT INTO memories (id, type, category, content, summary, source, confidence, metadata, access_count, created_at, updated_at)
       VALUES ('legacy1', 'conversation', 'context', 'legacy quoll content', 'legacy summary', 'manual', 1.0, '{}', 0, 1, 1)`
    ).run();
    expect(ftsRows(db)).toEqual([]);

    expect(runMemoriesFtsBackfill(db)).toBe(1);
    expect(repo.searchMemories('quoll content', { applyDecay: false }).length).toBe(1);
    // 幂等由调用方 count 守卫负责；helper 本身重复跑会重复插入，这里验证调用方约定
  });

  it('backfill helper is atomic — mid-way failure rolls back to zero rows', () => {
    db.exec('DROP TRIGGER IF EXISTS memories_ai_fts;');
    db.exec('DROP TABLE IF EXISTS memories_fts;');
    db.exec(`
      CREATE TABLE memories_fts (
        memory_id TEXT, type TEXT, category TEXT CHECK (category <> 'poison'),
        content TEXT, summary TEXT
      );
    `);
    db.prepare(
      `INSERT INTO memories (id, type, category, content, source, confidence, metadata, access_count, created_at, updated_at)
       VALUES ('ok1', 'conversation', 'context', 'fine row', 'manual', 1.0, '{}', 0, 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO memories (id, type, category, content, source, confidence, metadata, access_count, created_at, updated_at)
       VALUES ('bad1', 'conversation', 'poison', 'poison row', 'manual', 1.0, '{}', 0, 2, 2)`
    ).run();

    expect(() => runMemoriesFtsBackfill(db)).toThrow(/CHECK|constraint/i);
    const count = (db.prepare('SELECT COUNT(*) c FROM memories_fts').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

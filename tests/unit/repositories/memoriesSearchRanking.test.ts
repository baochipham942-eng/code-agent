// ============================================================================
// MemoryRepository — searchMemories 使用度排序（access_count / 最近触碰）
// ============================================================================
// - 衰减置信度打平时：accessCount 高者先，再按 (lastAccessedAt || updatedAt)
//   新者先（FTS 通道的 JS 排序；LIKE 通道的 SQL ORDER BY 同口径）
// - now 可注入：decay 用 options.now ?? Date.now()，测试用固定时钟
// - 无使用度数据（access_count 全 0、last_accessed_at 全 NULL）时排序与
//   改动前逐位一致（回归护栏）
// 衰减倍率取 0.5 的整数次幂（半衰期整数倍），IEEE 浮点可精确表示，
// 保证"衰减后置信度相等"的夹具不靠浮点巧合。半衰期/阈值真源是
// shared/constants 的 MEMORY，不在测试里复写数字。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applyMemoriesFtsSchema } from '../../../src/shared/memoriesFts.sql';
import { MemoryRepository } from '../../../src/host/services/core/repositories/MemoryRepository';
import { MEMORY } from '../../../src/shared/constants';

const HALF_LIFE_MS = MEMORY.RECORD_DECAY_DAYS * 24 * 60 * 60 * 1000;
// 固定时钟基准：所有用例以 NOW 为"当前时间"，不依赖真实墙钟
const NOW = 1_900_000_000_000;

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
      status TEXT NOT NULL DEFAULT 'active',
      deprecated_by TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER
    );
  `);
}

/** 直落一行记忆并精确控制使用度/时间字段；trigger 会自动同步进 memories_fts */
function insertMemory(
  db: BetterSqlite3.Database,
  row: {
    id: string;
    content: string;
    summary?: string;
    confidence: number;
    accessCount: number;
    updatedAt: number;
    lastAccessedAt?: number;
  }
): void {
  db.prepare(`
    INSERT INTO memories (id, type, category, content, summary, source, confidence, metadata, status, access_count, created_at, updated_at, last_accessed_at)
    VALUES (?, 'project_knowledge', 'context', ?, ?, 'manual', ?, '{}', 'active', ?, ?, ?, ?)
  `).run(
    row.id,
    row.content,
    row.summary ?? null,
    row.confidence,
    row.accessCount,
    row.updatedAt,
    row.updatedAt,
    row.lastAccessedAt ?? null
  );
}

describe('MemoryRepository — searchMemories 使用度排序', () => {
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

  // ---- FTS 通道（decay 开、固定时钟） ---------------------------------------

  it('衰减置信度打平时按 accessCount 高者先（FTS 通道）', () => {
    // frequent：BM25 弱相关但 accessCount 高；rare：BM25 强相关但 accessCount 低。
    // 两者 updatedAt 相同 → 衰减后置信度严格相等（1.0 × 0.5^1），
    // 老排序（只看置信度，稳定排序保 FTS rank 序）会输出 [rare, frequent]
    insertMemory(db, {
      id: 'frequent',
      content: 'mentions okapi once among many other unrelated words here',
      confidence: 1.0,
      accessCount: 7,
      updatedAt: NOW - HALF_LIFE_MS,
    });
    insertMemory(db, {
      id: 'rare',
      content: 'okapi okapi okapi — dedicated okapi troubleshooting guide',
      summary: 'okapi guide',
      confidence: 1.0,
      accessCount: 1,
      updatedAt: NOW - HALF_LIFE_MS,
    });

    const results = repo.searchMemories('okapi', { now: NOW });
    expect(results.map(m => m.id)).toEqual(['frequent', 'rare']);
  });

  it('置信度与 accessCount 都打平时按最近触碰新者先（FTS 通道）', () => {
    // older：raw confidence 1.0、触碰在半衰期前 → 衰减后 0.5；BM25 强相关
    // newer：raw confidence 0.5、刚触碰（decay 因子 1.0）→ 衰减后 0.5；BM25 弱相关
    // 两个 0.5 都是 2 的幂次的精确浮点乘积 → 严格打平，轮到第三键定序
    insertMemory(db, {
      id: 'older',
      content: 'pangolin pangolin pangolin — dedicated pangolin runbook',
      summary: 'pangolin runbook',
      confidence: 1.0,
      accessCount: 3,
      updatedAt: NOW - HALF_LIFE_MS,
    });
    insertMemory(db, {
      id: 'newer',
      content: 'mentions pangolin once among many other unrelated words',
      confidence: 0.5,
      accessCount: 3,
      updatedAt: NOW,
      lastAccessedAt: NOW,
    });

    const results = repo.searchMemories('pangolin', { now: NOW });
    expect(results.map(m => m.id)).toEqual(['newer', 'older']);
  });

  it('无使用度数据时排序与改动前一致：仍按衰减置信度降序（FTS 通道）', () => {
    // access_count 全 0、last_accessed_at 全 NULL：置信度严格有序，轮不到次级键
    insertMemory(db, { id: 'stale', content: 'quokka stale fact', confidence: 1.0, accessCount: 0, updatedAt: NOW - 3 * HALF_LIFE_MS });
    insertMemory(db, { id: 'fresh', content: 'quokka fresh fact', confidence: 1.0, accessCount: 0, updatedAt: NOW - HALF_LIFE_MS });
    insertMemory(db, { id: 'newest', content: 'quokka newest fact', confidence: 1.0, accessCount: 0, updatedAt: NOW });

    const results = repo.searchMemories('quokka', { now: NOW });
    expect(results.map(m => m.id)).toEqual(['newest', 'fresh', 'stale']);
  });

  it('注入的 now 驱动 decay：同一行在更晚的时钟下跌破阈值被过滤', () => {
    // 距 NOW 三个半衰期 → 0.125 ≥ 0.1 保留；再拨远一个半衰期 → 0.0625 < 0.1 过滤
    insertMemory(db, { id: 'fading', content: 'narwhal fading fact', confidence: 1.0, accessCount: 0, updatedAt: NOW - 3 * HALF_LIFE_MS });

    expect(repo.searchMemories('narwhal fading fact', { now: NOW }).map(m => m.id)).toEqual(['fading']);
    expect(repo.searchMemories('narwhal fading fact', { now: NOW + HALF_LIFE_MS })).toEqual([]);
  });

  // ---- LIKE 通道（<3 字符强制 LIKE；applyDecay: false 直接钉 SQL 序） --------

  it('LIKE 通道按 access_count 降序、再按 COALESCE(last_accessed_at, updated_at) 降序', () => {
    // most-used 靠 access_count 拔头筹；r/p/q 的 access_count 同为 4：
    //   r 无 last_accessed_at → COALESCE 取 updated_at 12_000 最先；
    //   p (last_accessed 5_000) 必须排在 q (last_accessed 4_000) 前——
    //   老的 ORDER BY updated_at DESC 会把 q (9_000) 排在 p (1_000) 前
    insertMemory(db, { id: 'q', content: 'shared zx marker older-access', confidence: 1.0, accessCount: 4, updatedAt: 9_000, lastAccessedAt: 4_000 });
    insertMemory(db, { id: 'p', content: 'shared zx marker newer-access', confidence: 1.0, accessCount: 4, updatedAt: 1_000, lastAccessedAt: 5_000 });
    insertMemory(db, { id: 'r', content: 'shared zx marker never-accessed', confidence: 1.0, accessCount: 4, updatedAt: 12_000 });
    insertMemory(db, { id: 'most-used', content: 'shared zx marker most used', confidence: 1.0, accessCount: 9, updatedAt: 500 });

    const results = repo.searchMemories('zx', { applyDecay: false });
    expect(results.map(m => m.id)).toEqual(['most-used', 'r', 'p', 'q']);
  });

  it('LIKE 通道无使用度数据时排序与改动前一致：access_count 全 0 时退化为 updated_at 降序', () => {
    insertMemory(db, { id: 'old', content: 'shared zq row old', confidence: 1.0, accessCount: 0, updatedAt: 1_000 });
    insertMemory(db, { id: 'mid', content: 'shared zq row mid', confidence: 1.0, accessCount: 0, updatedAt: 5_000 });
    insertMemory(db, { id: 'top', content: 'shared zq row top', confidence: 1.0, accessCount: 0, updatedAt: 9_000 });

    const results = repo.searchMemories('zq', { applyDecay: false });
    expect(results.map(m => m.id)).toEqual(['top', 'mid', 'old']);
  });
});

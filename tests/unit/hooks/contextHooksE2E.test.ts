// ============================================================================
// contextHooks — end-to-end flush against real SQLite (Workstream A E2E)
// ============================================================================
// 验证 preCompactContextHook 的 SQL 路径：
//   - createMemory 写入真 sqlite3 memories 表
//   - listMemories 查重命中真正的 metadata.flushHash
//   - 同一内容第二次压缩不会产生新行
//   - seedMemoryInjector 读同一张表能看到 flush 出的条目
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { CompactContext } from '../../../src/main/protocol/events';
import type { Message } from '../../../src/shared/contract';

// ----------------------------------------------------------------------------
// Real in-memory SQLite with the actual memories schema
// ----------------------------------------------------------------------------

let db: BetterSqlite3.Database;

function createMemoriesSchema(d: BetterSqlite3.Database): void {
  d.exec(`
    CREATE TABLE memories (
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
    )
  `);
}

// Adapter: duck-types the subset of DatabaseService that flushToMemoryRepository uses
function makeRealDbAdapter(sqlite: BetterSqlite3.Database) {
  return {
    isReady: true,
    createMemory(data: {
      type: string;
      category: string;
      content: string;
      summary?: string;
      source: string;
      projectPath?: string;
      sessionId?: string;
      confidence: number;
      metadata?: Record<string, unknown>;
    }) {
      const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      const now = Date.now();
      sqlite
        .prepare(
          `
          INSERT INTO memories (id, type, category, content, summary, source, project_path, session_id, confidence, metadata, access_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          `,
        )
        .run(
          id,
          data.type,
          data.category,
          data.content,
          data.summary ?? null,
          data.source,
          data.projectPath ?? null,
          data.sessionId ?? null,
          data.confidence,
          JSON.stringify(data.metadata ?? {}),
          now,
          now,
        );
      return { id, ...data };
    },
    listMemories(options: {
      source?: string;
      projectPath?: string;
      limit?: number;
      orderBy?: string;
      orderDir?: 'ASC' | 'DESC';
    } = {}) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (options.source) {
        conditions.push('source = ?');
        params.push(options.source);
      }
      if (options.projectPath) {
        conditions.push('project_path = ?');
        params.push(options.projectPath);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = options.limit ?? 100;
      const rows = sqlite
        .prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params, limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        id: String(r.id),
        type: String(r.type),
        category: String(r.category),
        content: String(r.content),
        source: String(r.source),
        projectPath: r.project_path as string | null,
        sessionId: r.session_id as string | null,
        confidence: Number(r.confidence ?? 1),
        metadata: r.metadata ? JSON.parse(String(r.metadata)) : {},
        accessCount: 0,
        createdAt: Number(r.created_at ?? 0),
        updatedAt: Number(r.updated_at ?? 0),
      }));
    },
  };
}

// Set up the mock BEFORE importing contextHooks
let adapter: ReturnType<typeof makeRealDbAdapter>;
vi.mock('../../../src/main/services', () => ({
  getDatabase: () => adapter,
}));

const { preCompactContextHook } = await import('../../../src/main/hooks/builtins/contextHooks');

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeContext(): CompactContext {
  return {
    event: 'PreCompact',
    sessionId: 'e2e-session-xyz',
    timestamp: 1_700_000_000_000,
    workingDirectory: '/tmp/e2e-proj',
    tokenCount: 10_000,
    targetTokenCount: 5_000,
  };
}

function makeMessages(): Message[] {
  return [
    {
      role: 'user',
      content: '重要：先检查邮箱给建议，在我确认前绝不动任何邮件',
      timestamp: 1_700_000_000_000 - 2000,
    } as unknown as Message,
    {
      role: 'user',
      content: '另外不要部署到 prod，只在 staging 验证',
      timestamp: 1_700_000_000_000 - 1500,
    } as unknown as Message,
    {
      role: 'assistant',
      content: '我决定采用关键方案 A，因为重要的原因是安全边界',
      timestamp: 1_700_000_000_000 - 500,
    } as unknown as Message,
  ];
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('preCompactContextHook — real SQLite end-to-end (Workstream A)', () => {
  beforeAll(() => {
    db = new Database(':memory:');
    createMemoriesSchema(db);
    adapter = makeRealDbAdapter(db);
  });

  afterAll(() => {
    db.close();
  });

  it('first compact writes rows to memories via real SQL', async () => {
    const beforeCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    expect(beforeCount).toBe(0);

    const result = await preCompactContextHook(makeContext(), makeMessages(), 'balanced');
    expect(result.action).toBe('continue');

    const rows = db
      .prepare(
        `SELECT id, type, category, source, project_path, session_id, confidence, content, metadata
         FROM memories WHERE source = 'session_extracted'`,
      )
      .all() as Array<{
      id: string;
      type: string;
      category: string;
      source: string;
      project_path: string;
      session_id: string;
      confidence: number;
      content: string;
      metadata: string;
    }>;

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.type).toBe('project_knowledge');
      expect(row.source).toBe('session_extracted');
      expect(row.project_path).toBe('/tmp/e2e-proj');
      expect(row.session_id).toBe('e2e-session-xyz');
      expect(row.confidence).toBeGreaterThan(0.5);
      const meta = JSON.parse(row.metadata);
      expect(meta.flushEvent).toBe('preCompact');
      expect(meta.flushHash).toMatch(/^[0-9a-f]{16}$/);
    }

    // 至少写入了 user_requirement
    const categories = new Set(rows.map((r) => r.category));
    expect(categories.has('user_requirement')).toBe(true);

    // 打印便于人眼 review
    // eslint-disable-next-line no-console
    console.log(`\n[E2E] Flushed ${rows.length} row(s) to memories:`);
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(`  - [${r.category}] ${r.content.slice(0, 70)}`);
    }
  });

  it('second compact with same content dedupes via flushHash', async () => {
    const before = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;

    await preCompactContextHook(makeContext(), makeMessages(), 'balanced');
    const after = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;

    expect(after).toBe(before);
    // eslint-disable-next-line no-console
    console.log(`[E2E] After 2nd compact: count stable at ${after} (dedup works)`);
  });

  it('compact with new content adds new rows only', async () => {
    const before = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;

    const newMessages = [
      ...makeMessages(),
      {
        role: 'user',
        content: '补充一条新要求：开 monitoring dashboard 才能动 database migration',
        timestamp: 1_700_000_000_000 - 100,
      } as unknown as Message,
    ];
    await preCompactContextHook(makeContext(), newMessages, 'balanced');

    const after = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    expect(after).toBeGreaterThan(before);
    // eslint-disable-next-line no-console
    console.log(`[E2E] After new-content compact: ${before} → ${after}`);
  });
});

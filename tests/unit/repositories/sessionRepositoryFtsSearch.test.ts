// ============================================================================
// sessionRepositoryFtsSearch — direct unit tests (N-TEST-BACKFILL-T01)
// ============================================================================
// tests/unit/repositories/sessionRepositoryFts.test.ts and
// tests/unit/database/ftsRepair.test.ts exercise these functions through the
// SessionRepository facade / file-corruption scenarios. This file imports the
// extracted module directly and pins its own branches: query normalization,
// visibility/role/session scoping, limit caps, the short-query LIKE fallback,
// the degraded-state fallback, corruption-triggered repair + retry, and the
// transcript search filters.
//
// 夹具走生产 applyTestSessionSchema（真实 triggers 建 FTS 索引），不手抄 DDL。
// ftsRepair 用 importOriginal 透传 + 可翻转的 repairShouldThrow 注入
// 「修复阶梯自身抛错」（与 tests/unit/database/ftsRepair.test.ts 同款写法）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

// 注入「修复阶梯自身抛错」：默认透传真实现，单测翻转开关。
const ftsRepairMockState = vi.hoisted(() => ({ repairShouldThrow: false }));
vi.mock('../../../src/host/services/core/database/ftsRepair', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/services/core/database/ftsRepair')>();
  return {
    ...original,
    repairFtsTable: Object.assign(
      (
        db: BetterSqlite3.Database,
        table: Parameters<typeof original.repairFtsTable>[1],
        hooks?: Parameters<typeof original.repairFtsTable>[2],
      ) => {
        if (ftsRepairMockState.repairShouldThrow) {
          throw new Error('injected repair ladder failure');
        }
        return original.repairFtsTable(db, table, hooks);
      },
      original.repairFtsTable,
    ),
  };
});

import {
  markFtsTableRepairFailed,
  probeFtsTable,
  repairFtsTable,
} from '../../../src/host/services/core/database/ftsRepair';
import {
  runSessionMessagesFtsCount,
  runSessionMessagesFtsSearch,
  runTranscriptFtsSearch,
} from '../../../src/host/services/core/repositories/sessionRepositoryFtsSearch';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

const TOOL_CALLS_JSON = JSON.stringify([
  {
    type: 'object',
    name: 'read_file',
    arguments: { path: 'src/alpha.ts' },
    result: { output: 'alpha stdout payload' },
  },
]);

interface Rig {
  db: BetterSqlite3.Database;
}

function createRig(): Rig {
  const db = new Database(':memory:');
  applyTestSessionSchema(db);
  return { db };
}

function seedSession(db: BetterSqlite3.Database, id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, user_id, title, model_provider, model_name, status, is_deleted, created_at, updated_at)
    VALUES (?, NULL, ?, 'test', 'test-model', 'idle', 0, 1, 1)
  `).run(id, `session-${id}`);
}

function seedMessage(
  db: BetterSqlite3.Database,
  sessionId: string,
  id: string,
  content: string,
  timestamp: number,
  extra: { role?: string; isMeta?: number; visibility?: string; thinking?: string; toolCalls?: string } = {},
): void {
  db.prepare(`
    INSERT INTO messages (id, session_id, role, content, timestamp, is_meta, visibility, thinking, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    sessionId,
    extra.role ?? 'user',
    content,
    timestamp,
    extra.isMeta ?? 0,
    extra.visibility ?? 'active',
    extra.thinking ?? null,
    extra.toolCalls ?? null,
  );
}

function seedNeedleCorpus(db: BetterSqlite3.Database): void {
  seedSession(db, 's1');
  seedSession(db, 's2');
  seedSession(db, 's3');
  for (const [sessionId, index] of [['s1', 0], ['s2', 1], ['s3', 2]] as const) {
    seedMessage(db, sessionId, `needle-user-${sessionId}`, `needle hit ${index} 验收关键词`, 1_000 + index);
    seedMessage(db, sessionId, `needle-assist-${sessionId}`, `needle reply ${index}`, 2_000 + index, { role: 'assistant' });
  }
}

const dirs: string[] = [];

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-fts-search-'));
  dirs.push(dir);
  return path.join(dir, 'code-agent.db');
}

function corruptFtsShadowPages(dbPath: string, names: string[]): void {
  const db = new Database(dbPath);
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const placeholders = names.map(() => '?').join(', ');
  const pages = db.prepare(`
    SELECT name, pageno, pagetype FROM dbstat
    WHERE name IN (${placeholders}) AND pagetype = 'leaf'
  `).all(...names) as Array<{ name: string; pageno: number; pagetype: string }>;
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

function openFileDb(dbPath: string): BetterSqlite3.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function seedCorruptibleSearchDb(dbPath: string): BetterSqlite3.Database {
  const db = openFileDb(dbPath);
  applyTestSessionSchema(db);
  seedSession(db, 's1');
  for (let i = 0; i < 50; i += 1) {
    seedMessage(db, 's1', `m-${i}`, `hello world unique needle ${i} 验收关键词`, 1_000 + i);
  }
  return db;
}

afterEach(() => {
  ftsRepairMockState.repairShouldThrow = false;
  repairFtsTable.resetStateForTests();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runSessionMessagesFtsSearch — FTS path', () => {
  let rig: Rig;

  beforeEach(() => {
    rig = createRig();
  });

  afterEach(() => rig.db.close());

  it('returns mapped hits across sessions with role and timestamps', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    const hits = runSessionMessagesFtsSearch(db, 'needle');

    expect(hits.length).toBeGreaterThanOrEqual(6);
    for (const hit of hits) {
      expect(hit).toMatchObject({
        sessionId: expect.stringMatching(/^s[123]$/),
        content: expect.stringContaining('needle'),
        timestamp: expect.any(Number),
      });
      expect(['user', 'assistant']).toContain(hit.role);
      expect(hit.messageId).not.toBeNull();
    }
  });

  it('honors the role filter', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    const hits = runSessionMessagesFtsSearch(db, 'needle', { role: 'assistant' });

    expect(hits.length).toBeGreaterThanOrEqual(3);
    expect(hits.every((hit) => hit.role === 'assistant')).toBe(true);
  });

  it('prefers sessionIds over sessionId when both are given', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    const hits = runSessionMessagesFtsSearch(db, 'needle', { sessionId: 's1', sessionIds: ['s2'] });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.sessionId === 's2')).toBe(true);
  });

  it('excludes rewound messages by default and recalls them with includeRewound', () => {
    const { db } = rig;
    seedNeedleCorpus(db);
    db.prepare("UPDATE messages SET visibility = 'rewound' WHERE id = 'needle-user-s1'").run();

    expect(runSessionMessagesFtsSearch(db, 'needle').some((hit) => hit.messageId === 'needle-user-s1')).toBe(false);
    const all = runSessionMessagesFtsSearch(db, 'needle', { includeRewound: true });
    expect(all.some((hit) => hit.messageId === 'needle-user-s1')).toBe(true);
  });

  it('never recalls meta or loop-internal messages in either mode', () => {
    const { db } = rig;
    seedNeedleCorpus(db);
    seedMessage(db, 's1', 'meta-1', 'needle meta secret', 3_000, { isMeta: 1 });
    seedMessage(db, 's1', 'loop-1', '【循环模式 · 第2轮】needle', 3_100);
    seedMessage(db, 's1', 'loop-2', '[[LOOP_WAIT]] needle', 3_200);

    for (const includeRewound of [false, true]) {
      const hits = runSessionMessagesFtsSearch(db, 'needle', { includeRewound });
      const ids = hits.map((hit) => hit.messageId);
      expect(ids).not.toContain('meta-1');
      expect(ids).not.toContain('loop-1');
      expect(ids).not.toContain('loop-2');
    }
  });

  it('applies the default limit, the 50 hard cap, limitCap overrides, and a 1-row floor', () => {
    const { db } = rig;
    seedSession(db, 's1');
    for (let i = 0; i < 120; i += 1) {
      seedMessage(db, 's1', `cap-${i}`, `capneedle item ${i}`, 1_000 + i);
    }

    expect(runSessionMessagesFtsSearch(db, 'capneedle')).toHaveLength(10);
    expect(runSessionMessagesFtsSearch(db, 'capneedle', { limit: 100 })).toHaveLength(50);
    expect(runSessionMessagesFtsSearch(db, 'capneedle', { limit: 100, limitCap: 200 })).toHaveLength(100);
    expect(runSessionMessagesFtsSearch(db, 'capneedle', { limit: 0 })).toHaveLength(1);
  });

  it('matches FTS syntax characters literally by quoting the query', () => {
    const { db } = rig;
    seedSession(db, 's1');
    seedMessage(db, 's1', 'near-1', 'use NEAR(a b) here', 1_000);
    seedMessage(db, 's1', 'quote-1', 'say "hi" now', 1_100);

    expect(runSessionMessagesFtsSearch(db, 'NEAR(a b)').map((hit) => hit.messageId)).toEqual(['near-1']);
    expect(runSessionMessagesFtsSearch(db, 'say "hi"').map((hit) => hit.messageId)).toEqual(['quote-1']);
  });

  it('trims surrounding whitespace from the query', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    expect(runSessionMessagesFtsSearch(db, '  needle  ').length).toBeGreaterThan(0);
  });

  it('passes a query that already starts with a quote through verbatim', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    // Leading quote → the caller owns the FTS quoting; no double wrap.
    const hits = runSessionMessagesFtsSearch(db, '"needle"');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.content.includes('needle'))).toBe(true);
  });
});

describe('runSessionMessagesFtsSearch — short query LIKE fallback', () => {
  let rig: Rig;

  beforeEach(() => {
    rig = createRig();
  });

  afterEach(() => rig.db.close());

  it('returns empty below the trigram minimum without the fallback flag', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    expect(runSessionMessagesFtsSearch(db, '验收')).toEqual([]);
  });

  it('falls back to LIKE for short queries only when the flag is set', () => {
    const { db } = rig;
    seedNeedleCorpus(db);
    db.prepare("UPDATE messages SET visibility = 'rewound' WHERE id = 'needle-user-s1'").run();

    // Default LIKE visibility口径 excludes rewound rows (2 of 3 remain).
    const hits = runSessionMessagesFtsSearch(db, '验收', { shortQueryFallback: true });
    expect(hits.map((hit) => hit.messageId).sort()).toEqual(['needle-user-s2', 'needle-user-s3']);
    const all = runSessionMessagesFtsSearch(db, '验收', { shortQueryFallback: true, includeRewound: true });
    expect(all.map((hit) => hit.messageId).sort()).toEqual(['needle-user-s1', 'needle-user-s2', 'needle-user-s3']);
  });

  it('never falls back for an empty query even with the flag set', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    expect(runSessionMessagesFtsSearch(db, '', { shortQueryFallback: true })).toEqual([]);
    expect(runSessionMessagesFtsSearch(db, '   ', { shortQueryFallback: true })).toEqual([]);
  });

  it('escapes LIKE wildcards in the pattern', () => {
    const { db } = rig;
    seedSession(db, 's1');
    seedMessage(db, 's1', 'under-1', 'a_b key', 1_000);
    seedMessage(db, 's1', 'plain-1', 'axb plain', 1_100);

    const hits = runSessionMessagesFtsSearch(db, 'a_', { shortQueryFallback: true });

    expect(hits.map((hit) => hit.messageId)).toEqual(['under-1']);
  });

  it('applies sessionIds, sessionId, and role filters inside the LIKE fallback', () => {
    const { db } = rig;
    seedSession(db, 's1');
    seedSession(db, 's2');
    seedMessage(db, 's1', 'q-u1', '甲问内容', 1_000);
    seedMessage(db, 's1', 'q-a1', '乙答内容', 1_100, { role: 'assistant' });
    seedMessage(db, 's2', 'q-a2', '乙答另外', 1_200, { role: 'assistant' });

    const scoped = runSessionMessagesFtsSearch(db, '乙', { shortQueryFallback: true, sessionIds: ['s1', 's2'] });
    expect(scoped.map((hit) => hit.messageId).sort()).toEqual(['q-a1', 'q-a2']);

    const oneSession = runSessionMessagesFtsSearch(db, '乙', { shortQueryFallback: true, sessionId: 's1' });
    expect(oneSession.map((hit) => hit.messageId)).toEqual(['q-a1']);

    const byRole = runSessionMessagesFtsSearch(db, '乙', { shortQueryFallback: true, role: 'user' });
    expect(byRole).toEqual([]);
    const assistants = runSessionMessagesFtsSearch(db, '乙', { shortQueryFallback: true, role: 'assistant' });
    expect(assistants).toHaveLength(2);
  });

  it('routes every query through LIKE while the FTS table is in a degraded state', () => {
    const { db } = rig;
    seedNeedleCorpus(db);
    markFtsTableRepairFailed('session_messages_fts');

    const hits = runSessionMessagesFtsSearch(db, 'needle');
    expect(hits.length).toBeGreaterThan(0);
    // Degraded LIKE fallback keeps the default visibility口径: rewound hidden.
    db.prepare("UPDATE messages SET visibility = 'rewound' WHERE id = 'needle-user-s1'").run();
    expect(runSessionMessagesFtsSearch(db, 'needle').some((hit) => hit.messageId === 'needle-user-s1')).toBe(false);
  });
});

describe('runSessionMessagesFtsSearch — corruption repair ladder', () => {
  it('repairs a corrupt FTS index and retries the search successfully', () => {
    const dbPath = tmpDbPath();
    const seeded = seedCorruptibleSearchDb(dbPath);
    seeded.close();

    corruptFtsShadowPages(dbPath, ['session_messages_fts_data', 'session_messages_fts_idx']);
    const db = openFileDb(dbPath);

    const hits = runSessionMessagesFtsSearch(db, 'needle', { limit: 50 });
    expect(hits.length).toBe(50);
    expect(probeFtsTable(db, 'session_messages_fts')).toBe('ok');
    db.close();
  });

  it('degrades to the LIKE fallback when the repair ladder itself fails', () => {
    const dbPath = tmpDbPath();
    const seeded = seedCorruptibleSearchDb(dbPath);
    seeded.close();

    corruptFtsShadowPages(dbPath, ['session_messages_fts_data', 'session_messages_fts_idx']);
    const db = openFileDb(dbPath);
    ftsRepairMockState.repairShouldThrow = true;

    const hits = runSessionMessagesFtsSearch(db, 'needle', { limit: 50 });

    expect(hits.length).toBe(50);
    expect(probeFtsTable(db, 'session_messages_fts')).toBe('corrupt');
    db.close();
  });

  it('rethrows non-corruption errors such as a missing FTS table', () => {
    const { db } = createRig();
    seedNeedleCorpus(db);
    db.exec('DROP TABLE session_messages_fts');

    expect(() => runSessionMessagesFtsSearch(db, 'needle')).toThrow(/no such table/);
    db.close();
  });

  it('skips the repair ladder when the probe proves the FTS table is intact (source table corrupt)', () => {
    // Corrupt the messages leaf pages, not the FTS index: MATCH fails with
    // corruption, the probe proves session_messages_fts is healthy, repair is
    // skipped, the retry fails again, and the LIKE fallback swallows to [].
    const dbPath = tmpDbPath();
    const seeded = seedCorruptibleSearchDb(dbPath);
    seeded.close();

    corruptFtsShadowPages(dbPath, ['messages']);
    const db = openFileDb(dbPath);

    expect(runSessionMessagesFtsSearch(db, 'needle', { limit: 50 })).toEqual([]);
    expect(probeFtsTable(db, 'session_messages_fts')).toBe('ok');
    db.close();
  });
});

describe('runSessionMessagesFtsCount', () => {
  let rig: Rig;

  beforeEach(() => {
    rig = createRig();
  });

  afterEach(() => rig.db.close());

  it('counts full matches and distinct sessions beyond the search limit', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    expect(runSessionMessagesFtsCount(db, 'needle')).toEqual({ matches: 6, sessions: 3 });
    expect(runSessionMessagesFtsCount(db, 'needle', { role: 'assistant' })).toEqual({ matches: 3, sessions: 3 });
    expect(runSessionMessagesFtsCount(db, 'needle', { sessionId: 's1' })).toEqual({ matches: 2, sessions: 1 });
    expect(runSessionMessagesFtsCount(db, 'needle', { sessionId: 's1', sessionIds: ['s2'] })).toEqual({ matches: 2, sessions: 1 });
  });

  it('counts rewound messages only with includeRewound', () => {
    const { db } = rig;
    seedNeedleCorpus(db);
    db.prepare("UPDATE messages SET visibility = 'rewound' WHERE id = 'needle-user-s1'").run();

    expect(runSessionMessagesFtsCount(db, 'needle')).toEqual({ matches: 5, sessions: 3 });
    expect(runSessionMessagesFtsCount(db, 'needle', { includeRewound: true })).toEqual({ matches: 6, sessions: 3 });
  });

  it('returns zero for short or empty queries even with the fallback flag', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    expect(runSessionMessagesFtsCount(db, '验收')).toEqual({ matches: 0, sessions: 0 });
    expect(runSessionMessagesFtsCount(db, '验收', { shortQueryFallback: true })).toEqual({ matches: 3, sessions: 3 });
    expect(runSessionMessagesFtsCount(db, '', { shortQueryFallback: true })).toEqual({ matches: 0, sessions: 0 });
  });

  it('routes counts through LIKE while degraded and rethrows non-corruption errors', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    markFtsTableRepairFailed('session_messages_fts');
    expect(runSessionMessagesFtsCount(db, 'needle')).toEqual({ matches: 6, sessions: 3 });
    repairFtsTable.resetStateForTests();

    db.exec('DROP TABLE session_messages_fts');
    expect(() => runSessionMessagesFtsCount(db, 'needle')).toThrow(/no such table/);
  });

  it('degrades to LIKE counts when the repair ladder fails on a corrupt index', () => {
    const dbPath = tmpDbPath();
    const seeded = seedCorruptibleSearchDb(dbPath);
    seeded.close();

    corruptFtsShadowPages(dbPath, ['session_messages_fts_data', 'session_messages_fts_idx']);
    const db = openFileDb(dbPath);
    ftsRepairMockState.repairShouldThrow = true;

    expect(runSessionMessagesFtsCount(db, 'needle')).toEqual({ matches: 50, sessions: 1 });
    db.close();
  });

  it('retries after a successful repair when the corruption is in the source table', () => {
    const dbPath = tmpDbPath();
    const seeded = seedCorruptibleSearchDb(dbPath);
    seeded.close();

    // messages corrupt / FTS intact: repair is skipped (probe ok), retry fails,
    // and the LIKE count fallback degrades to zero instead of throwing.
    corruptFtsShadowPages(dbPath, ['messages']);
    const db = openFileDb(dbPath);

    expect(runSessionMessagesFtsCount(db, 'needle')).toEqual({ matches: 0, sessions: 0 });
    expect(probeFtsTable(db, 'session_messages_fts')).toBe('ok');
    db.close();
  });

  it('applies session filters inside the LIKE count fallback', () => {
    const { db } = rig;
    seedNeedleCorpus(db);

    expect(runSessionMessagesFtsCount(db, '验收', { shortQueryFallback: true, sessionIds: ['s2'] }))
      .toEqual({ matches: 1, sessions: 1 });
    expect(runSessionMessagesFtsCount(db, '验收', { shortQueryFallback: true, role: 'assistant' }))
      .toEqual({ matches: 0, sessions: 0 });
  });
});

describe('runTranscriptFtsSearch', () => {
  let rig: Rig;

  beforeEach(() => {
    rig = createRig();
  });

  afterEach(() => rig.db.close());

  function seedTranscriptCorpus(db: BetterSqlite3.Database): void {
    seedSession(db, 's1');
    seedSession(db, 's2');
    seedMessage(db, 's1', 't-user', 'hello transcript world', 100);
    seedMessage(db, 's1', 't-think', 'visible answer', 200, {
      role: 'assistant',
      thinking: 'quiet reasoning trace',
    });
    seedMessage(db, 's1', 't-tool', 'running tool', 300, {
      role: 'assistant',
      toolCalls: TOOL_CALLS_JSON,
    });
    seedMessage(db, 's2', 't-other', 'other session transcript tool_output', 400, { role: 'assistant' });
  }

  it('finds text, reasoning, and tool kinds with mapped fields and snippets', () => {
    const { db } = rig;
    seedTranscriptCorpus(db);

    const text = runTranscriptFtsSearch(db, 'transcript');
    expect(text.map((hit) => hit.messageId).sort()).toEqual(['t-other', 't-user']);
    const user = text.find((hit) => hit.messageId === 't-user');
    expect(user).toMatchObject({ sessionId: 's1', kind: 'user_text', toolName: null, timestamp: 100 });
    expect(user?.snippet).toContain('«transcript»');

    const reasoning = runTranscriptFtsSearch(db, 'reasoning trace');
    expect(reasoning.map((hit) => hit.kind)).toEqual(['reasoning']);

    const toolInput = runTranscriptFtsSearch(db, 'alpha.ts');
    expect(toolInput).toHaveLength(1);
    expect(toolInput[0]).toMatchObject({ messageId: 't-tool', kind: 'tool_input', toolName: 'read_file' });

    const toolOutput = runTranscriptFtsSearch(db, 'stdout payload');
    expect(toolOutput).toHaveLength(1);
    expect(toolOutput[0]).toMatchObject({ messageId: 't-tool', kind: 'tool_output', toolName: 'read_file' });
  });

  it('filters by kind, toolName, session, and time window', () => {
    const { db } = rig;
    seedTranscriptCorpus(db);

    expect(runTranscriptFtsSearch(db, 'transcript', { kinds: ['user_text'] }).map((hit) => hit.messageId))
      .toEqual(['t-user']);
    expect(runTranscriptFtsSearch(db, 'alpha.ts', { toolName: 'read_file' }).map((hit) => hit.messageId))
      .toEqual(['t-tool']);
    expect(runTranscriptFtsSearch(db, 'alpha.ts', { toolName: 'other_tool' })).toEqual([]);
    expect(runTranscriptFtsSearch(db, 'transcript', { sessionId: 's2' }).map((hit) => hit.messageId))
      .toEqual(['t-other']);
    expect(runTranscriptFtsSearch(db, 'transcript', { timeAfter: 350 }).map((hit) => hit.messageId))
      .toEqual(['t-other']);
    expect(runTranscriptFtsSearch(db, 'transcript', { timeBefore: 250 }).map((hit) => hit.messageId))
      .toEqual(['t-user']);
  });

  it('applies the limit with a 1-row floor and excludes rewound rows unless includeRewound', () => {
    const { db } = rig;
    seedTranscriptCorpus(db);
    db.prepare("UPDATE messages SET visibility = 'rewound' WHERE id = 't-user'").run();

    expect(runTranscriptFtsSearch(db, 'transcript', { limit: 0 }).length).toBe(1);
    expect(runTranscriptFtsSearch(db, 'transcript').some((hit) => hit.messageId === 't-user')).toBe(false);
    expect(runTranscriptFtsSearch(db, 'transcript', { includeRewound: true }).some((hit) => hit.messageId === 't-user'))
      .toBe(true);
  });

  it('returns empty for queries below the trigram minimum', () => {
    const { db } = rig;
    seedTranscriptCorpus(db);

    expect(runTranscriptFtsSearch(db, 'ab')).toEqual([]);
    expect(runTranscriptFtsSearch(db, '  ')).toEqual([]);
  });

  it('rethrows non-corruption errors such as a missing transcript table', () => {
    const { db } = rig;
    seedTranscriptCorpus(db);
    db.exec('DROP TABLE transcript_fts');

    expect(() => runTranscriptFtsSearch(db, 'transcript')).toThrow(/no such table/);
  });

  it('repairs a corrupt transcript index and returns empty for the current call', () => {
    const dbPath = tmpDbPath();
    const seeded = openFileDb(dbPath);
    applyTestSessionSchema(seeded);
    seedSession(seeded, 's1');
    for (let i = 0; i < 40; i += 1) {
      seedMessage(seeded, 's1', `tt-${i}`, `transcript needle body ${i}`, 1_000 + i);
    }
    seeded.close();

    corruptFtsShadowPages(dbPath, ['transcript_fts_data', 'transcript_fts_idx']);
    const db = openFileDb(dbPath);

    expect(runTranscriptFtsSearch(db, 'transcript')).toEqual([]);
    expect(probeFtsTable(db, 'transcript_fts')).toBe('ok');
    expect(runTranscriptFtsSearch(db, 'needle', { limit: 40 }).length).toBe(40);
    db.close();
  });
});

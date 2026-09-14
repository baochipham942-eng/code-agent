import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

// 注入「修复阶梯自身抛错」：默认放行真实现，单测翻转开关。
// 真实现经 vi.mock 包装后仍是同一个 availability 状态机（importOriginal 透传）。
const ftsRepairMockState = vi.hoisted(() => ({ repairShouldThrow: false }));
vi.mock('../../../src/host/services/core/database/ftsRepair', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/services/core/database/ftsRepair')>();
  return {
    ...original,
    repairFtsTable: (
      db: BetterSqlite3.Database,
      table: Parameters<typeof original.repairFtsTable>[1],
      hooks?: Parameters<typeof original.repairFtsTable>[2],
    ) => {
      if (ftsRepairMockState.repairShouldThrow) {
        throw new Error('injected repair ladder failure');
      }
      return original.repairFtsTable(db, table, hooks);
    },
  };
});

import {
  getDisabledFtsTables,
  isFtsDisabled,
  isFtsSearchDegraded,
  markFtsTableDisabledForTests,
  repairCorruptFtsOnStartup,
  repairFtsTable,
  resetFtsRepairStateForTests,
} from '../../../src/host/services/core/database/ftsRepair';
import { rebuildSessionMessagesFts } from '../../../src/host/services/core/database/sessionMessagesFts';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import type { Message } from '../../../src/shared/contract';
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

// 夹具走生产 applySchema（messagesSchemaFixtureGate 要求），不再手抄 messages DDL。
function createSchema(db: BetterSqlite3.Database): void {
  db.pragma('journal_mode = WAL');
  applyTestSessionSchema(db);
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
    ftsRepairMockState.repairShouldThrow = false;
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

  it('empty recreate immediately refills from source: degraded state clears without waiting for backfill', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 20);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: true });
    ({ db, repo } = openRepo(dbPath));

    // 第一次重建失败（走空表重建），回填用真重建：DROP 后损坏页已消失，应当成功
    let rebuildCalls = 0;
    const outcome = repairFtsTable(db, 'session_messages_fts', {
      rebuild: (database) => {
        rebuildCalls += 1;
        if (rebuildCalls === 1) throw new Error('injected rebuild failure');
        return rebuildSessionMessagesFts(database);
      },
    });
    expect(outcome).toBe('rebuilt');
    expect(rebuildCalls).toBe(2);
    expect(isFtsSearchDegraded('session_messages_fts')).toBe(false);
    const hits = repo.searchSessionMessagesFts('needle', { limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    db.close();
  });

  it('startup backfill refills an empty-recreated table and clears the degraded state', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 20);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: true });
    ({ db, repo } = openRepo(dbPath));

    // 重建+回填都注入失败 → 停在 empty 降级态
    const outcome = repairFtsTable(db, 'session_messages_fts', {
      rebuild: () => {
        throw new Error('injected rebuild failure');
      },
    });
    expect(outcome).toBe('empty-recreated');
    expect(isFtsSearchDegraded('session_messages_fts')).toBe(true);

    // 注入只挂在这次 repairFtsTable 调用；启动 backfill 走真重建，成功后降级态消除
    repo.backfillSessionMessagesFts();
    expect(isFtsSearchDegraded('session_messages_fts')).toBe(false);
    const hits = repo.searchSessionMessagesFts('needle', { limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    db.close();
  });

  it('degraded LIKE fallback keeps rewound messages when includeRewound=true, in hits and count', () => {
    const dbPath = tmpDb();
    const { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 10);
    // visibility 是兼容性 cache 字段；rewind 后的消息应从默认搜索消失、includeRewound 时保留
    repo.updateMessage('m-2', { visibility: 'rewound' }, 'sess-1');
    markFtsTableDisabledForTests('session_messages_fts');

    const visibleOnly = repo.searchSessionMessagesFts('needle', { limit: 50 });
    expect(visibleOnly.some((hit) => hit.messageId === 'm-2')).toBe(false);

    const withRewound = repo.searchSessionMessagesFts('needle', { limit: 50, includeRewound: true });
    expect(withRewound.some((hit) => hit.messageId === 'm-2')).toBe(true);
    expect(withRewound.length).toBe(visibleOnly.length + 1);

    const visibleCount = repo.countSessionMessagesFts('needle');
    const rewoundCount = repo.countSessionMessagesFts('needle', { includeRewound: true });
    expect(rewoundCount.matches).toBe(visibleCount.matches + 1);
    db.close();
  });

  it('search falls back to LIKE without throwing when the repair ladder itself fails (readonly DB)', () => {
    const dbPath = tmpDb();
    const { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 30);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: false });

    // 只读打开：MATCH 抛损坏；修复阶梯的重建/重建空表全部 readonly 失败，
    // 阶梯内部消化后落 disabled。搜索走 LIKE,不抛。
    const roDb = new Database(dbPath, { readonly: true });
    const roRepo = new SessionRepository(roDb);
    let hits: ReturnType<SessionRepository['searchSessionMessagesFts']> = [];
    expect(() => {
      hits = roRepo.searchSessionMessagesFts('needle', { limit: 50 });
    }).not.toThrow();
    expect(hits.length).toBeGreaterThan(0);
    expect(isFtsSearchDegraded('session_messages_fts')).toBe(true);

    // 计数路径同样不抛且走 LIKE
    let count = { matches: 0, sessions: 0 };
    expect(() => {
      count = roRepo.countSessionMessagesFts('needle');
    }).not.toThrow();
    expect(count.matches).toBeGreaterThan(0);
    roDb.close();
  });

  it('search does not throw when the repair ladder itself throws; LIKE still recalls', () => {
    const dbPath = tmpDb();
    let { db, repo } = openRepo(dbPath);
    createSchema(db);
    insertSession(db, 'sess-1');
    seedMessages(repo, 30);
    db.close();

    corruptFtsShadowPages(dbPath, { leafOnly: false });
    ({ db, repo } = openRepo(dbPath));

    // 修复阶梯自身抛错（契约上不应发生,但 sqlite_master 不可读等极端损坏下可能漏出）:
    // 搜索接口不许把异常穿给调用方——落降级态走 LIKE。
    ftsRepairMockState.repairShouldThrow = true;
    let hits: ReturnType<SessionRepository['searchSessionMessagesFts']> = [];
    expect(() => {
      hits = repo.searchSessionMessagesFts('needle', { limit: 50 });
    }).not.toThrow();
    expect(hits.length).toBeGreaterThan(0);
    expect(isFtsSearchDegraded('session_messages_fts')).toBe(true);

    let count = { matches: 0, sessions: 0 };
    expect(() => {
      count = repo.countSessionMessagesFts('needle');
    }).not.toThrow();
    expect(count.matches).toBeGreaterThan(0);
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

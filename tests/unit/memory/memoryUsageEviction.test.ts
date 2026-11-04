// N-MEM-CITEBACK-RANK-EVICT 验收 ①–④：
// 真 SQLite（:memory: + 真 schema + 真 MemoryRepository）+ 固定时钟（vi.useFakeTimers），
// 主断言全部穿过 buildPackedSeedMemory / 真 MemoryRead / 真搜索通道，packer 不 mock。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../src/host/protocol/tools';
import type { MemoryRecord } from '../../../src/host/protocol/types/repositories';

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.unmock('better-sqlite3');

vi.mock('../../../src/host/services/core/database/nativeLoader', async () => {
  const module = await import('better-sqlite3');
  return {
    loadBetterSqlite3: () => module.default,
  };
});

vi.mock('../../../src/host/services/core/databaseService', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/core/databaseService')>(
    '../../../src/host/services/core/databaseService',
  );
  return {
    ...actual,
    getDatabase: () => {
      if (!dbHolder.current) throw new Error('Database not initialized');
      return dbHolder.current as ReturnType<typeof actual.getDatabase>;
    },
  };
});

vi.mock('../../../src/host/services/infra/logger', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/services/infra/logger')>(
    '../../../src/host/services/infra/logger',
  );
  return { ...actual, createLogger: () => loggerMock };
});

import Database from 'better-sqlite3';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { MemoryRepository } from '../../../src/host/services/core/repositories/MemoryRepository';
import { memoryEntryMetadata } from '../../../src/host/memory/memoryEntryMetadata';
import {
  listUnifiedMemoryEntries,
  packMemoryEntries,
  rebuildMemoryMirrorFromLightFiles,
  storedMemoryToEntry,
} from '../../../src/host/memory/memoryEntryRuntime';
import { memoryInjectionPauses, resumeMemoryInjection } from '../../../src/host/memory/memoryUsageEviction';
import { buildPackedSeedMemory } from '../../../src/host/utils/seedMemoryInjector';
import { memoryReadModule } from '../../../src/host/tools/modules/lightMemory/memoryRead';
import { memorySearchModule } from '../../../src/host/tools/modules/lightMemory/memorySearch';
import { MEMORY } from '../../../src/shared/constants';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 固定时钟：所有过期判定都相对这个时刻 */
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeToolLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

type DbWrapper = {
  isReady: boolean;
  listMemories: (options?: Parameters<MemoryRepository['listMemories']>[0]) => MemoryRecord[];
  getMemory: (id: string) => MemoryRecord | null;
  createMemory: (data: Parameters<MemoryRepository['createMemory']>[0]) => MemoryRecord;
  updateMemory: (id: string, updates: Partial<MemoryRecord>) => MemoryRecord | null;
  recordMemoryAccess: (id: string) => void;
  searchMemories: (query: string, options?: { limit?: number; applyDecay?: boolean }) => MemoryRecord[];
};

let raw: Database.Database | null = null;
let repo: MemoryRepository | null = null;
let db: DbWrapper | null = null;
let seq = 0;

function currentDb(): DbWrapper {
  if (!db) throw new Error('db not initialized');
  return db;
}

function currentRepo(): MemoryRepository {
  if (!repo) throw new Error('repo not initialized');
  return repo;
}

function wrapRepo(repository: MemoryRepository): DbWrapper {
  return {
    isReady: true,
    listMemories: (options) => repository.listMemories(options ?? {}),
    getMemory: (id) => repository.getMemory(id),
    createMemory: (data) => repository.createMemory(data),
    updateMemory: (id, updates) => repository.updateMemory(id, updates),
    recordMemoryAccess: (id) => repository.recordMemoryAccess(id),
    searchMemories: (query, options) => repository.searchMemories(query, options ?? {}),
  };
}

function lightFile(title: string, body: string): string {
  return `---
name: ${title}
description: fixture ${title}
type: user
---

${body}
`;
}

let dataDir = '';
let memDir = '';

async function mirrorEntry(prefix: string, token: string): Promise<{ filename: string; rowId: string; entryId: string }> {
  seq += 1;
  const filename = `${prefix}-${seq}.md`;
  await fs.writeFile(path.join(memDir, filename), lightFile(filename, `${prefix} body ${token}`), 'utf8');
  const rebuilt = await rebuildMemoryMirrorFromLightFiles(currentDb());
  expect(rebuilt.skipped).toEqual([]);
  const row = currentDb()
    .listMemories({ includeArchived: true, includeCandidates: true, limit: 1000, orderBy: 'updated_at', orderDir: 'DESC' })
    .find((memory) => memoryEntryMetadata(memory)?.filePath === filename);
  if (!row) throw new Error(`mirror row missing for ${filename}`);
  return { filename, rowId: row.id, entryId: storedMemoryToEntry(row).id };
}

function setUsage(rowId: string, accessCount: number, lastAccessedAt: number | null): void {
  if (!raw) throw new Error('db not initialized');
  raw.prepare('UPDATE memories SET access_count = ?, last_accessed_at = ? WHERE id = ?')
    .run(accessCount, lastAccessedAt, rowId);
}

function backdate(rowId: string, ts: number): void {
  if (!raw) throw new Error('db not initialized');
  raw.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, rowId);
}

async function injectedEntryIds(options?: { excludeEntryIds?: string[] }): Promise<string[]> {
  const packed = await buildPackedSeedMemory(options ?? {});
  expect(packed).not.toBeNull();
  return (packed?.packed.items ?? []).map((item) => item.entryId);
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: dataDir,
    abortSignal: ctrl.signal,
    logger: makeToolLogger(),
    emit: () => undefined,
    ...overrides,
  };
}

async function executeRead(args: Record<string, unknown>, ctx: ToolContext, permit: CanUseToolFn = allowAll) {
  const handler = await memoryReadModule.createHandler();
  return handler.execute(args, ctx, permit);
}

describe('memoryUsageEviction（seed 注入用量淘汰）', () => {
  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-evict-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    memDir = path.join(dataDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
  });

  afterAll(async () => {
    delete process.env.CODE_AGENT_DATA_DIR;
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // 每个用例一套全新 :memory: 库 + 干净的 light memory 目录，互相不串
    for (const entry of await fs.readdir(memDir)) {
      await fs.rm(path.join(memDir, entry), { recursive: true, force: true });
    }
    raw = new Database(':memory:');
    applySchema(raw, loggerMock as unknown as Parameters<typeof applySchema>[1]);
    repo = new MemoryRepository(raw);
    db = wrapRepo(repo);
    dbHolder.current = db;
  });

  afterEach(() => {
    vi.useRealTimers();
    dbHolder.current = null;
    db = null;
    repo = null;
    raw?.close();
    raw = null;
  });

  it('① 用过且 >30 天未再用：不进注入块，但 MemoryRead/搜索照常返回、行未删', async () => {
    vi.useFakeTimers({ now: NOW });
    const stale = await mirrorEntry('stale', 'zirceanstale');
    const fresh = await mirrorEntry('fresh', 'zirceanfresh');
    const never = await mirrorEntry('never', 'zirceannever');
    setUsage(stale.rowId, 3, NOW - 40 * DAY_MS);
    setUsage(fresh.rowId, 2, NOW - 5 * DAY_MS);
    setUsage(never.rowId, 0, null);

    const ids = await injectedEntryIds();
    expect(ids).toContain(fresh.entryId);
    expect(ids).toContain(never.entryId);
    expect(ids).not.toContain(stale.entryId);

    // 行未删、统一入口仍列出
    expect(currentDb().getMemory(stale.rowId)?.content).toContain('zirceanstale');
    const unified = await listUnifiedMemoryEntries(currentDb());
    expect(unified.entries.map((entry) => entry.id)).toContain(stale.entryId);

    // MemoryRead 照常可读（不因淘汰被挡）
    const read = await executeRead({ filename: stale.filename }, makeCtx({ runId: 'run-stale' }));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.output).toContain('zirceanstale');

    // 搜索照常返回（结果按文件名列出，计数为 1 = 只命中这条）
    const searchHandler = await memorySearchModule.createHandler();
    const searched = await searchHandler.execute({ query: 'zirceanstale' }, makeCtx(), allowAll);
    expect(searched.ok).toBe(true);
    if (searched.ok) {
      expect(searched.output).toContain(stale.filename);
      expect(searched.meta?.count).toBe(1);
    }
  });

  it('② 从未用过（含很老的）/ 30 天内用过 / 恰好 30 天边界 / 有次数无时间戳：照常注入', async () => {
    vi.useFakeTimers({ now: NOW });
    const neverOld = await mirrorEntry('neverold', 'zircebneverold');
    const fresh = await mirrorEntry('freshwin', 'zircebfreshwin');
    const boundary = await mirrorEntry('boundary', 'zircebboundary');
    const noStamp = await mirrorEntry('nostamp', 'zircebnostamp');
    setUsage(neverOld.rowId, 0, null);
    backdate(neverOld.rowId, NOW - 400 * DAY_MS);
    setUsage(fresh.rowId, 1, NOW - 5 * DAY_MS);
    setUsage(boundary.rowId, 2, NOW - MEMORY.SEED_STALE_USED_MS);
    setUsage(noStamp.rowId, 5, null);
    // 有次数无时间戳 + 行本身很老：仍不淘汰（不回落 updatedAt）
    backdate(noStamp.rowId, NOW - 400 * DAY_MS);

    const ids = await injectedEntryIds();
    expect(ids).toContain(neverOld.entryId);
    expect(ids).toContain(fresh.entryId);
    expect(ids).toContain(boundary.entryId);
    expect(ids).toContain(noStamp.entryId);
  });

  it('③ day one（存量记忆全部未用过）注入集合与改动前完全一致', async () => {
    vi.useFakeTimers({ now: NOW });
    const a = await mirrorEntry('dayone-a', 'zircedayonea');
    const b = await mirrorEntry('dayone-b', 'zircedayoneb');
    const c = await mirrorEntry('dayone-c', 'zircedayonec');
    for (const entry of [a, b, c]) setUsage(entry.rowId, 0, null);
    backdate(c.rowId, NOW - 400 * DAY_MS);

    const injectorIds = await injectedEntryIds();
    expect(injectorIds.length).toBeGreaterThan(0);

    // 改动前行为 = 以同样参数直接调 packer（不经用量淘汰）；集合必须逐条一致
    const before = await packMemoryEntries({
      statuses: ['active'],
      kinds: ['user', 'feedback', 'project', 'reference', 'session', 'pattern'],
      maxItems: 10,
      perItemCharLimit: 120,
      totalCharBudget: 800,
    }, currentDb());
    const beforeIds = before.items.map((item) => item.entryId);
    expect(injectorIds).toEqual(beforeIds);
  });

  it('调用方 excludeEntryIds 与用量淘汰取并集', async () => {
    vi.useFakeTimers({ now: NOW });
    const stale = await mirrorEntry('union-stale', 'zirceunionstale');
    const fresh = await mirrorEntry('union-fresh', 'zirceunionfresh');
    const keeper = await mirrorEntry('union-keep', 'zirceunionkeep');
    setUsage(stale.rowId, 3, NOW - 40 * DAY_MS);
    setUsage(fresh.rowId, 1, NOW - 3 * DAY_MS);
    setUsage(keeper.rowId, 0, null);

    const ids = await injectedEntryIds({ excludeEntryIds: [fresh.entryId] });
    // keeper 在场证明打包本身成功了，两条排除不是「整体为空」的假绿
    expect(ids).toContain(keeper.entryId);
    expect(ids).not.toContain(fresh.entryId);
    expect(ids).not.toContain(stale.entryId);
  });

  it('④ 用量扫描出错时 fail-open：注入照常进行，不淘汰任何条目', async () => {
    vi.useFakeTimers({ now: NOW });
    const entry = await mirrorEntry('failopen', 'zircefailopen');
    setUsage(entry.rowId, 4, NOW - 60 * DAY_MS);

    // 直接单元断言：抛错的 db → 空集合 + warn 带原因
    const throwing = {
      listMemories: () => {
        throw new Error('boom scan');
      },
    } as unknown as Parameters<typeof memoryInjectionPauses>[0];
    expect(memoryInjectionPauses(throwing, NOW).size).toBe(0);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '[MemoryUsageEviction] usage scan failed, injecting without eviction',
      expect.objectContaining({ error: expect.stringContaining('boom scan') }),
    );
    expect(memoryInjectionPauses(undefined, NOW).size).toBe(0);

    // 端到端：扫描抛错（第一次 listMemories）不拖垮注入，条目照常注入
    let calls = 0;
    db = {
      ...currentDb(),
      listMemories: (options) => {
        calls += 1;
        if (calls === 1) throw new Error('boom scan');
        return currentRepo().listMemories(options ?? {});
      },
    };
    dbHolder.current = db;
    const ids = await injectedEntryIds();
    expect(ids).toContain(entry.entryId);
  });

  // ---- N-MEM-EVICT-NEVER-READ：从没被 MemoryRead 用过的也按宽限期老化（爸 10-14 定 B）----
  const LAUNCH = MEMORY.NEVER_USED_EVICTION_SINCE;
  const GRACE = MEMORY.SEED_NEVER_USED_GRACE_MS;

  it('从没用过：自上线日起过了宽限期退出注入；行仍在、MemoryRead 照常可读', async () => {
    const later = LAUNCH + GRACE + DAY_MS;
    vi.useFakeTimers({ now: later });
    const neverOld = await mirrorEntry('nr-old', 'zircfneverold');
    const used = await mirrorEntry('nr-used', 'zircfused');
    setUsage(neverOld.rowId, 0, null);
    backdate(neverOld.rowId, LAUNCH - 400 * DAY_MS);
    setUsage(used.rowId, 1, later - 2 * DAY_MS);
    backdate(used.rowId, LAUNCH - 400 * DAY_MS);

    const ids = await injectedEntryIds();
    expect(ids).toContain(used.entryId);
    expect(ids).not.toContain(neverOld.entryId);
    expect(memoryInjectionPauses(currentDb(), later).get(neverOld.entryId)).toEqual({ reason: 'never_used', since: LAUNCH + GRACE });

    const read = await executeRead({ filename: neverOld.filename }, makeCtx({ runId: 'run-never-old' }));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.output).toContain('zircfneverold');
  });

  it('从没用过：宽限期从创建时间与上线日中较晚者起算；宽限期内与边界照常注入', async () => {
    const now = LAUNCH + GRACE + 10 * DAY_MS;
    vi.useFakeTimers({ now });
    const recent = await mirrorEntry('nr-recent', 'zircfrecent');
    const boundary = await mirrorEntry('nr-boundary', 'zircfboundary');
    setUsage(recent.rowId, 0, null);
    backdate(recent.rowId, now - 5 * DAY_MS);
    setUsage(boundary.rowId, 0, null);
    backdate(boundary.rowId, now - GRACE);

    const ids = await injectedEntryIds();
    expect(ids).toContain(recent.entryId);
    expect(ids).toContain(boundary.entryId);
  });

  it('上线当天到宽限期满之前：存量从没用过的记忆一条都不淘汰', async () => {
    vi.useFakeTimers({ now: LAUNCH + GRACE - DAY_MS });
    const old = await mirrorEntry('nr-launch', 'zircflaunch');
    setUsage(old.rowId, 0, null);
    backdate(old.rowId, LAUNCH - 900 * DAY_MS);
    expect(memoryInjectionPauses(currentDb(), Date.now()).size).toBe(0);
    expect(await injectedEntryIds()).toContain(old.entryId);
  });

  it('恢复自动注入：记一次使用后回到注入集合；找不到的条目返回 false', async () => {
    const later = LAUNCH + GRACE + DAY_MS;
    vi.useFakeTimers({ now: later });
    const paused = await mirrorEntry('nr-resume', 'zircfresume');
    const keeper = await mirrorEntry('nr-keeper', 'zircfkeeper');
    setUsage(keeper.rowId, 1, later - DAY_MS);
    setUsage(paused.rowId, 0, null);
    backdate(paused.rowId, LAUNCH - 400 * DAY_MS);
    expect(await injectedEntryIds()).not.toContain(paused.entryId);

    expect(resumeMemoryInjection(currentDb(), paused.entryId)).toBe(true);
    expect(memoryInjectionPauses(currentDb(), later).has(paused.entryId)).toBe(false);
    expect(await injectedEntryIds()).toContain(paused.entryId);
    expect(resumeMemoryInjection(currentDb(), 'no-such-entry')).toBe(false);
  });
});

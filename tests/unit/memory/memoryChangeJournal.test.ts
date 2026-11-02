// ============================================================================
// Memory Change Journal — 记忆变更日志（N-MEM-JOURNAL-SOURCEJUMP ①）
// ============================================================================
// memories 表每次 create/update/delete/evict 追加一行 memory_change_journal：
// 时间 / 操作 / actor / 改前改后快照 / 关联 sessionId。append-only：旧行永不改。
// 日志写失败 fail-safe——只 warn，绝不拦记忆写入本身。
// ============================================================================

import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { MemoryRepository } from '../../../src/host/services/core/repositories/MemoryRepository';
import type { MemoryRecord } from '../../../src/host/protocol/types';
import {
  deleteMemoryEntry,
  listUnifiedMemoryEntries,
  rebuildMemoryMirrorFromLightFiles,
  updateMemoryEntry,
} from '../../../src/host/memory/memoryEntryRuntime';
import { parseMemoryJournalSnapshot } from '../../../src/renderer/components/features/settings/tabs/memoryJournalSnapshot';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

function createDb(): BetterSqlite3.Database {
  const db = new Database(':memory:');
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
  applySchema(db, logger);
  return db;
}

function makeMemoryInput(content: string, overrides: Partial<Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>> = {}) {
  return {
    type: 'project_knowledge',
    category: 'context',
    content,
    source: 'user_defined',
    confidence: 1.0,
    ...overrides,
  } as Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>;
}

describe('MemoryRepository — memory change journal', () => {
  let db: BetterSqlite3.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = createDb();
    repo = new MemoryRepository(db);
  });

  it('appends one create row with actor, snapshot and sessionId', () => {
    const created = repo.createMemory(
      makeMemoryInput('initial content', { summary: 'initial summary', sessionId: 'sess-a' }),
      { actor: 'user_manual', sessionId: 'sess-a' },
    );

    const rows = repo.listMemoryJournal({ memoryId: created.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: 'create',
      memoryId: created.id,
      actor: 'user_manual',
      sessionId: 'sess-a',
      beforeContent: null,
    });
    const after = JSON.parse(rows[0].afterContent as string) as { summary: string; content: string };
    expect(after.content).toBe('initial content');
    expect(after.summary).toBe('initial summary');
  });

  it('records two updates as two ordered rows and never modifies old rows', () => {
    const created = repo.createMemory(makeMemoryInput('v1'), { actor: 'user_manual' });
    repo.updateMemory(created.id, { content: 'v2' }, { actor: 'auto_review', sessionId: 'sess-b' });
    repo.updateMemory(created.id, { content: 'v3' }, { actor: 'dream' });

    const rows = repo.listMemoryJournal({ memoryId: created.id });
    expect(rows).toHaveLength(3);
    // 读序：新 → 旧（id DESC）
    expect(rows.map((row) => row.operation)).toEqual(['update', 'update', 'create']);
    expect(rows[0].actor).toBe('dream');
    expect(rows[1].actor).toBe('auto_review');
    expect(rows[1].sessionId).toBe('sess-b');
    // before/after 快照成链：第二次 update 的 before = 第一次 update 的 after
    const firstAfter = JSON.parse(rows[1].afterContent as string) as { content: string };
    const secondBefore = JSON.parse(rows[0].beforeContent as string) as { content: string };
    expect(firstAfter.content).toBe('v2');
    expect(secondBefore.content).toBe('v2');
    // append-only：create 行在两次 update 之后仍原样
    expect(rows[2].operation).toBe('create');
    expect(JSON.parse(rows[2].afterContent as string)).toMatchObject({ content: 'v1' });
  });

  it('keeps history readable after delete and marks the delete row', () => {
    const created = repo.createMemory(makeMemoryInput('doomed'), { actor: 'user_manual' });
    expect(repo.deleteMemory(created.id, { actor: 'user_manual' })).toBe(true);
    expect(repo.getMemory(created.id)).toBeNull();

    const rows = repo.listMemoryJournal({ memoryId: created.id });
    expect(rows.map((row) => row.operation)).toEqual(['delete', 'create']);
    // 删除行的 before 保留被删内容，after 为空
    expect(JSON.parse(rows[0].beforeContent as string)).toMatchObject({ content: 'doomed' });
    expect(rows[0].afterContent).toBeNull();
  });

  it('records evict when the caller marks a mirror removal', () => {
    const created = repo.createMemory(
      makeMemoryInput('mirrored', { metadata: { memoryEntry: { id: 'entry-x' } } }),
      { actor: 'import' },
    );
    repo.updateMemory(
      created.id,
      { status: 'archived' },
      { actor: 'eviction', operation: 'evict' },
    );

    const rows = repo.listMemoryJournal({ entryId: 'entry-x' });
    expect(rows[0]).toMatchObject({ operation: 'evict', actor: 'eviction', entryId: 'entry-x' });
  });

  it('falls back to actor unknown and derives sessionId from the record when the call site is silent', () => {
    const created = repo.createMemory(makeMemoryInput('quiet', { sessionId: 'sess-c' }));
    const rows = repo.listMemoryJournal({ memoryId: created.id });
    expect(rows[0].actor).toBe('unknown');
    expect(rows[0].sessionId).toBe('sess-c');
  });

  it('keeps the memory write alive when the journal append fails (fail-safe)', () => {
    const created = repo.createMemory(makeMemoryInput('survivor'), { actor: 'user_manual' });
    db.exec('DROP TABLE memory_change_journal');

    const updated = repo.updateMemory(created.id, { content: 'still written' });
    expect(updated?.content).toBe('still written');

    db.exec(`
      CREATE TABLE memory_change_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        operation TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        entry_id TEXT,
        actor TEXT NOT NULL,
        before_content TEXT,
        after_content TEXT,
        session_id TEXT
      )
    `);
    // 表回来后写入恢复
    repo.updateMemory(created.id, { content: 'journaled again' });
    const rows = repo.listMemoryJournal({ memoryId: created.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe('update');
  });

  it('clamps the journal read limit and reports each memory latest change once', () => {
    const a = repo.createMemory(makeMemoryInput('a'), { actor: 'user_manual' });
    const b = repo.createMemory(makeMemoryInput('b'), { actor: 'dream' });
    repo.updateMemory(a.id, { content: 'a2' }, { actor: 'auto_review' });

    const unclamped = repo.listMemoryJournal({ memoryId: a.id, limit: 999 });
    expect(unclamped.length).toBeLessThanOrEqual(200);

    const latest = repo.latestMemoryChanges();
    const byMemory = new Map(latest.map((change) => [change.memoryId, change]));
    expect(byMemory.get(a.id)).toMatchObject({ actor: 'auto_review', operation: 'update' });
    expect(byMemory.get(b.id)).toMatchObject({ actor: 'dream', operation: 'create' });
  });

  // --------------------------------------------------------------------------
  // 直建 DB 记忆的历史查询（rework r4 ②）：无 metadata.memoryEntry.id 的记忆
  // （desktopActivity / contextHooks 等直写路径）在面板里的条目 id 是
  // `db:${memoryId}` 兜底，journal 行只挂 memory_id——按 db: 前缀 entryId 查历史
  // 必须回落到 memory_id，与 annotateLastChange 的徽标解析同口径。
  // --------------------------------------------------------------------------
  it('finds journal rows for direct DB memories via the db:-prefixed entry id (r4)', () => {
    const created = repo.createMemory(
      makeMemoryInput('direct write', { sessionId: 'sess-bg' }),
      { actor: 'auto_review', sessionId: 'sess-bg' },
    );
    repo.updateMemory(created.id, { content: 'direct write v2' }, { actor: 'dream' });

    const rows = repo.listMemoryJournal({ entryId: `db:${created.id}` });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ operation: 'update', actor: 'dream' });
    expect(rows[1]).toMatchObject({ operation: 'create', actor: 'auto_review' });
    // 直建记忆没有统一条目 id，journal 行的 entry_id 为 null（解析只能走 memory_id）
    expect(rows.every((row) => row.entryId === null)).toBe(true);
  });

  it('journal lookup and lastChange annotation agree on direct DB memories (r4)', () => {
    const created = repo.createMemory(makeMemoryInput('badge path'), { actor: 'eviction' });

    // 徽标路径（annotateLastChange 同款解析）：db: 前缀剥掉按 memory_id 命中
    const latest = repo.latestMemoryChanges().find((change) => change.memoryId === created.id);
    expect(latest).toMatchObject({ actor: 'eviction', operation: 'create' });
    // 历史路径必须同样命中，否则「后台写入」徽标亮着、详情却恒显示暂无变更记录
    expect(repo.listMemoryJournal({ entryId: `db:${created.id}` })).toHaveLength(1);
    // 精确 entry_id 命中不受回落影响：带统一条目 id 的记忆照旧按 entry_id 查到
    repo.createMemory(
      makeMemoryInput('with unified entry id', {
        metadata: { memoryEntry: { id: 'entry_unified_1' } },
      } as Partial<Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>>),
      { actor: 'user_manual' },
    );
    expect(repo.listMemoryJournal({ entryId: 'entry_unified_1' })).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// 重建洪泛回归（rework r2 ①③）：rebuildMemoryMirrorFromLightFiles 会对每个既有
// 镜像调 updateMemory；无变化时不得追加日志行，否则一次面板编辑写 N 行 no-op
// user_manual，把其他条目上真实的后台标记抹掉。
// ----------------------------------------------------------------------------
describe('memory change journal — mirror rebuild no-op flood', () => {
  let tmpDir: string;
  let db: BetterSqlite3.Database;
  let repo: MemoryRepository;

  function journalCount(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM memory_change_journal').get() as { c: number }).c;
  }

  async function writeLightFile(filename: string, entryId: string, content: string): Promise<void> {
    await fs.writeFile(path.join(tmpDir, 'memory', filename), `---
name: Entry ${entryId}
description: Summary ${entryId}
type: project
entry_id: ${entryId}
status: active
source: knowledge_inbox
schema_version: 2
---

${content}
`, 'utf-8');
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-journal-rebuild-'));
    mockConfigDir.dir = tmpDir;
    await fs.mkdir(path.join(tmpDir, 'memory'), { recursive: true });
    db = createDb();
    repo = new MemoryRepository(db);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('a no-change background rebuild appends zero journal rows', async () => {
    await writeLightFile('entry-a.md', 'entry_a', 'Content A');
    await rebuildMemoryMirrorFromLightFiles(repo, { journal: { actor: 'import' } });
    expect(journalCount()).toBe(1);

    await rebuildMemoryMirrorFromLightFiles(repo, { journal: { actor: 'dream' } });
    expect(journalCount()).toBe(1);
  });

  it('editing one of three mirrors appends exactly one row and leaves the other lastChange markers intact', async () => {
    await writeLightFile('entry-a.md', 'entry_a', 'Content A');
    await writeLightFile('entry-b.md', 'entry_b', 'Content B');
    await writeLightFile('entry-c.md', 'entry_c', 'Content C');
    await rebuildMemoryMirrorFromLightFiles(repo, { journal: { actor: 'import' } });
    expect(journalCount()).toBe(3);
    // 无文件变化的后台重建：0 新行，三条 lastChange 仍是 import/create
    await rebuildMemoryMirrorFromLightFiles(repo, { journal: { actor: 'dream' } });
    expect(journalCount()).toBe(3);

    // 面板编辑 entry_b（user_manual 路径，与 memory.ipc 的 PANEL_JOURNAL 同款）
    await updateMemoryEntry(repo, { entryId: 'entry_b', content: 'Content B v2' }, { journal: { actor: 'user_manual' } });

    expect(journalCount()).toBe(4);
    expect(repo.listMemoryJournal({ entryId: 'entry_b' })[0]).toMatchObject({
      operation: 'update',
      actor: 'user_manual',
    });
    expect(repo.listMemoryJournal({ entryId: 'entry_a' })).toHaveLength(1);
    expect(repo.listMemoryJournal({ entryId: 'entry_c' })).toHaveLength(1);

    // 面板列表读路径：只有 entry_b 的 lastChange 是 user_manual，其余仍是后台 import
    const byId = new Map((await listUnifiedMemoryEntries(repo)).entries.map((entry) => [entry.id, entry]));
    expect(byId.get('entry_a')?.lastChange).toMatchObject({ actor: 'import', operation: 'create' });
    expect(byId.get('entry_b')?.lastChange).toMatchObject({ actor: 'user_manual', operation: 'update' });
    expect(byId.get('entry_c')?.lastChange).toMatchObject({ actor: 'import', operation: 'create' });
  });
});

// ----------------------------------------------------------------------------
// 逐行撤回（N-MEM-JOURNAL-SOURCEJUMP-FU2）：后台 update/delete(软归档)/evict 行的
// before 快照经面板既有 updateMemoryEntry 通道整段写回。断言：内容/状态恢复、
// 恰好新增一条 user_manual 行、旧行字节级不变；并用测试核实被清退/软归档条目
// 仍可被 updateMemoryEntry 定位（硬删条目则不可——UI 那侧禁用 + 原因）。
// ----------------------------------------------------------------------------
describe('memory change journal — per-row undo restore (FU2)', () => {
  let tmpDir: string;
  let db: BetterSqlite3.Database;
  let repo: MemoryRepository;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-journal-undo-'));
    mockConfigDir.dir = tmpDir;
    await fs.mkdir(path.join(tmpDir, 'memory'), { recursive: true });
    db = createDb();
    repo = new MemoryRepository(db);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** 面板撤回的实际负载形状：解析出的快照 → memoryEntryUpdate 请求字段 */
  function restorePayload(row: { beforeContent: string | null }) {
    const parsed = parseMemoryJournalSnapshot(row.beforeContent);
    if (!parsed?.restorable) throw new Error('snapshot not restorable');
    return { title: parsed.title, content: parsed.content, status: parsed.status };
  }

  it('restores a dream-rewritten memory from the before snapshot and appends exactly one user_manual row', async () => {
    const created = repo.createMemory(
      makeMemoryInput('v1 content', { summary: 'v1 title', metadata: { memoryEntry: { id: 'entry_undo_1' } } }),
      { actor: 'user_manual' },
    );
    repo.updateMemory(created.id, { content: 'rewritten by dream', summary: 'dream summary' }, { actor: 'dream' });

    const rowsBefore = repo.listMemoryJournal({ entryId: 'entry_undo_1' });
    expect(rowsBefore.map((row) => row.operation)).toEqual(['update', 'create']);
    const payload = restorePayload(rowsBefore[0]);
    expect(payload).toEqual({ title: 'v1 title', content: 'v1 content', status: 'active' });

    await updateMemoryEntry(repo, { entryId: 'entry_undo_1', ...payload }, { journal: { actor: 'user_manual' } });

    const rowsAfter = repo.listMemoryJournal({ entryId: 'entry_undo_1' });
    expect(rowsAfter).toHaveLength(rowsBefore.length + 1);
    expect(rowsAfter[0]).toMatchObject({ operation: 'update', actor: 'user_manual', entryId: 'entry_undo_1' });
    // append-only：撤回前的所有行字节级不变
    expect(rowsAfter.slice(1)).toEqual(rowsBefore);

    const record = repo.getMemory(created.id);
    expect(record?.content).toBe('v1 content');
    expect(record?.status).toBe('active');
    expect(record?.summary).toBe('v1 title');
  });

  it('restores a background soft-archived (deleted) entry back to its pre-delete state', async () => {
    repo.createMemory(
      makeMemoryInput('delete me later', { summary: 'del title', metadata: { memoryEntry: { id: 'entry_undo_2' } } }),
      { actor: 'user_manual' },
    );
    // 后台删除 = 软归档（deleteMemoryEntry 复用 updateMemoryEntry 通道）
    await deleteMemoryEntry(repo, { entryId: 'entry_undo_2' }, { journal: { actor: 'eviction' } });

    const archived = (await listUnifiedMemoryEntries(repo)).entries.find((entry) => entry.id === 'entry_undo_2');
    expect(archived?.status).toBe('archived');

    const rowsBefore = repo.listMemoryJournal({ entryId: 'entry_undo_2' });
    const payload = restorePayload(rowsBefore[0]);
    expect(payload).toEqual({ title: 'del title', content: 'delete me later', status: 'active' });

    const result = await updateMemoryEntry(repo, { entryId: 'entry_undo_2', ...payload }, { journal: { actor: 'user_manual' } });
    expect(result.entry.status).toBe('active');
    expect(result.entry.content).toBe('delete me later');
    expect(result.entry.deprecatedBy).toBeNull();

    const rowsAfter = repo.listMemoryJournal({ entryId: 'entry_undo_2' });
    expect(rowsAfter).toHaveLength(rowsBefore.length + 1);
    expect(rowsAfter[0]).toMatchObject({ actor: 'user_manual' });
    expect(rowsAfter.slice(1)).toEqual(rowsBefore);
  });

  it('restores an evicted light-file entry: the file is re-created and the mirror row returns to active', async () => {
    await fs.writeFile(path.join(tmpDir, 'memory', 'entry-evict.md'), `---
name: Entry evict
description: Summary evict
type: project
entry_id: entry_evict
status: active
source: knowledge_inbox
schema_version: 2
---

Evict me
`, 'utf-8');
    await rebuildMemoryMirrorFromLightFiles(repo, { journal: { actor: 'import' } });
    // 后台清退：light 文件消失后重建镜像（软归档，不硬删）
    await fs.rm(path.join(tmpDir, 'memory', 'entry-evict.md'));
    await rebuildMemoryMirrorFromLightFiles(repo, { journal: { actor: 'dream' } });

    const rowsBefore = repo.listMemoryJournal({ entryId: 'entry_evict' });
    expect(rowsBefore[0]).toMatchObject({ operation: 'evict', actor: 'eviction' });

    const evicted = (await listUnifiedMemoryEntries(repo)).entries.find((entry) => entry.id === 'entry_evict');
    expect(evicted?.status).toBe('archived');

    const payload = restorePayload(rowsBefore[0]);
    const result = await updateMemoryEntry(repo, { entryId: 'entry_evict', ...payload }, { journal: { actor: 'user_manual' } });
    expect(result.entry.status).toBe('active');
    expect(result.entry.content).toBe('Evict me');

    const rowsAfter = repo.listMemoryJournal({ entryId: 'entry_evict' });
    expect(rowsAfter[0]).toMatchObject({ actor: 'user_manual' });
    expect(rowsAfter.slice(1)).toEqual(rowsBefore);
  });

  it('cannot restore a hard-deleted memory — the entry is unresolvable (UI must disable, not pretend)', async () => {
    const created = repo.createMemory(
      makeMemoryInput('hard deleted', { metadata: { memoryEntry: { id: 'entry_undo_4' } } }),
      { actor: 'user_manual' },
    );
    repo.deleteMemory(created.id, { actor: 'auto_review' });
    const deleteRow = repo.listMemoryJournal({ entryId: 'entry_undo_4' })[0];
    expect(deleteRow).toMatchObject({ operation: 'delete', actor: 'auto_review' });
    expect(restorePayload(deleteRow)).toEqual({ title: '', content: 'hard deleted', status: 'active' });

    const entries = (await listUnifiedMemoryEntries(repo)).entries.filter((entry) => entry.id === 'entry_undo_4');
    expect(entries).toHaveLength(0);
    // 硬删后 updateMemoryEntry 解析不到条目 → 面板只能禁用 + 原因
    await expect(updateMemoryEntry(repo, {
      entryId: 'entry_undo_4',
      ...restorePayload(deleteRow),
    }, { journal: { actor: 'user_manual' } })).rejects.toThrow('Memory entry not found: entry_undo_4');
  });
});

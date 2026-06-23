import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

// memory.ipc.ts 的 MEMORY domain dispatch 覆盖（audit/inboxResolve 巨块逻辑暂不深测）。
// 核心 CRUD（list/update/delete/deleteByCategory/export/import/getMemoryStats）走
// getDatabase 项目知识 + 偏好两源映射；light*/v2 entry handler 委派给 runtime 模块。
// 纯 helper（formatValueForDisplay/shouldHidePreference/mapToNewCategory）真跑。

const db = vi.hoisted(() => ({
  getAllProjectKnowledge: vi.fn((): unknown[] => []),
  getAllPreferences: vi.fn((): Record<string, unknown> => ({})),
  updateProjectKnowledge: vi.fn(() => true),
  setPreference: vi.fn(),
  deleteProjectKnowledge: vi.fn(() => true),
  deletePreference: vi.fn(),
  deleteProjectKnowledgeBySource: vi.fn(() => 3),
  saveProjectKnowledge: vi.fn(),
}));
const rt = vi.hoisted(() => ({
  listUnifiedMemoryEntries: vi.fn(async () => [{ id: 'e1' }]),
  rebuildMemoryMirrorFromLightFiles: vi.fn(async () => ({ rebuilt: 5 })),
  updateMemoryEntry: vi.fn(async () => ({ ok: true })),
  deleteMemoryEntry: vi.fn(async () => ({ ok: true })),
  packMemoryEntries: vi.fn(async () => ({ packed: 2 })),
  exportMemoryBundleV2: vi.fn(async () => ({ bundle: 'v2' })),
  dryRunImportMemoryBundleV2: vi.fn(async () => ({ willImport: 1 })),
  applyImportMemoryBundleV2: vi.fn(async () => ({ imported: 1 })),
}));
const light = vi.hoisted(() => ({
  listMemoryFiles: vi.fn(async () => ['a.md']),
  readMemoryFile: vi.fn(async () => 'content'),
  deleteMemoryFile: vi.fn(async () => true),
  getLightMemoryStats: vi.fn(async () => ({ files: 1 })),
  getLightMemoryHealth: vi.fn(async () => ({ healthy: true })),
  rebuildLightMemoryIndex: vi.fn(async () => ({ rebuilt: true })),
}));

vi.mock('../../../src/main/services', () => ({
  getDatabase: () => db,
  getSessionManager: () => ({}),
}));
vi.mock('../../../src/main/lightMemory/lightMemoryIpc', () => light);
vi.mock('../../../src/main/memory/memoryEntryRuntime', () => ({
  ...rt,
  buildActiveMemoryEntryFromInbox: vi.fn(),
  createMemoryMirrorRecord: vi.fn(),
  lightMemoryFileToEntry: vi.fn(),
  storedMemoryToEntry: vi.fn(),
  writeActiveEntryToLightMemory: vi.fn(),
}));
vi.mock('../../../src/main/memory/memoryInjectionTrace', () => ({ listMemoryInjectionTraces: vi.fn(async () => []) }));
vi.mock('../../../src/main/memory/knowledgeInboxDecision', () => ({
  KNOWLEDGE_INBOX_DECISION_CATEGORY: 'inbox',
  hashInboxContent: vi.fn(() => 'hash'),
  parseKnowledgeInboxDecision: vi.fn(() => null),
  shouldSuppressMemoryByInboxDecision: vi.fn(() => false),
}));
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerMemoryHandlers } from '../../../src/main/ipc/memory.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let handlers: Map<string, HandlerFn>;
const call = (action: string, payload?: unknown) => handlers.get(IPC_DOMAINS.MEMORY)!(null, { action, payload } as IPCRequest);

const pk = (over: Record<string, unknown> = {}) => ({
  id: '1', key: 'note', value: '记一笔', source: 'learned', confidence: 0.9, createdAt: 100, updatedAt: 200, projectPath: '/p', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.getAllProjectKnowledge.mockReturnValue([]);
  db.getAllPreferences.mockReturnValue({});
  db.updateProjectKnowledge.mockReturnValue(true);
  db.deleteProjectKnowledge.mockReturnValue(true);
  db.deleteProjectKnowledgeBySource.mockReturnValue(3);
  handlers = new Map<string, HandlerFn>();
  registerMemoryHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
});

describe('dispatch', () => {
  it('未知 action → INVALID_ACTION', async () => {
    expect(await call('bogus')).toMatchObject({ success: false, error: { code: 'INVALID_ACTION' } });
  });

  it('handler 抛错 → INTERNAL_ERROR', async () => {
    db.getAllProjectKnowledge.mockImplementation(() => {
      throw new Error('db down');
    });
    expect(await call('list')).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: 'db down' } });
  });
});

describe('list — 映射 + 过滤 + 排序', () => {
  it('合并项目知识与偏好两源，按 updatedAt 降序', async () => {
    db.getAllProjectKnowledge.mockReturnValue([pk({ id: '1', updatedAt: 100 }), pk({ id: '2', updatedAt: 300 })]);
    db.getAllPreferences.mockReturnValue({ theme: 'dark' });
    const res = await call('list', {});
    const items = res.data as Array<{ id: string; category: string }>;
    // pref 的 updatedAt=Date.now()（远大于 pk 的 300/100）→ 排最前，pk 按 updatedAt 降序
    expect(items.map((i) => i.id)).toEqual(['pref_theme', 'pk_2', 'pk_1']);
    expect(items.find((i) => i.id === 'pref_theme')?.category).toBe('preference');
  });

  it('隐藏内部偏好（tool_preferences）', async () => {
    db.getAllPreferences.mockReturnValue({ tool_preferences: { read: 5 }, codingStyle: 'tabs' });
    const items = (await call('list', {})).data as Array<{ id: string }>;
    expect(items.some((i) => i.id === 'pref_tool_preferences')).toBe(false);
    expect(items.some((i) => i.id === 'pref_codingStyle')).toBe(true);
  });

  it('category 过滤只返回该类', async () => {
    db.getAllProjectKnowledge.mockReturnValue([pk({ source: 'learned' })]);
    db.getAllPreferences.mockReturnValue({ theme: 'dark' });
    const items = (await call('list', { category: 'preference' })).data as unknown[];
    expect(items).toHaveLength(1);
    expect((items[0] as { category: string }).category).toBe('preference');
  });
});

describe('update / delete 按 id 前缀路由', () => {
  it('pk_ → updateProjectKnowledge', async () => {
    expect((await call('update', { id: 'pk_42', content: '改' })).data).toBe(true);
    expect(db.updateProjectKnowledge).toHaveBeenCalledWith('42', '改');
  });

  it('pref_ → setPreference', async () => {
    expect((await call('update', { id: 'pref_theme', content: 'light' })).data).toBe(true);
    expect(db.setPreference).toHaveBeenCalledWith('theme', 'light');
  });

  it('未知前缀 → false', async () => {
    expect((await call('update', { id: 'x', content: 'y' })).data).toBe(false);
  });

  it('delete pk_ → deleteProjectKnowledge；pref_ → deletePreference；其他 false', async () => {
    expect((await call('delete', { id: 'pk_9' })).data).toBe(true);
    expect(db.deleteProjectKnowledge).toHaveBeenCalledWith('9');
    expect((await call('delete', { id: 'pref_theme' })).data).toBe(true);
    expect(db.deletePreference).toHaveBeenCalledWith('theme');
    expect((await call('delete', { id: 'zzz' })).data).toBe(false);
  });
});

describe('deleteByCategory', () => {
  it('preference → 逐个删偏好并计数', async () => {
    db.getAllPreferences.mockReturnValue({ a: 1, b: 2 });
    expect((await call('deleteByCategory', { category: 'preference' })).data).toBe(2);
    // Codex 审计：断言删的是哪些 key，错删别的 key 不能绿
    expect(db.deletePreference).toHaveBeenCalledWith('a');
    expect(db.deletePreference).toHaveBeenCalledWith('b');
    expect(db.deletePreference).toHaveBeenCalledTimes(2);
  });

  it('其他分类 → deleteProjectKnowledgeBySource(映射后的旧源名)', async () => {
    expect((await call('deleteByCategory', { category: 'learned' })).data).toBe(3);
    expect(db.deleteProjectKnowledgeBySource).toHaveBeenCalledWith('learned');
  });
});

describe('export / import / stats', () => {
  it('export 包裹 list 结果', async () => {
    db.getAllProjectKnowledge.mockReturnValue([pk()]);
    const res = (await call('export')).data as { version: number; items: unknown[] };
    expect(res.version).toBe(1);
    expect(res.items).toHaveLength(1);
  });

  it('import 偏好按 key:value 解析，知识走 saveProjectKnowledge，异常计 skip', async () => {
    db.setPreference.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const data = {
      items: [
        { category: 'preference', content: 'theme: dark', source: 'explicit', confidence: 1 },
        { category: 'learned', content: '经验一则', source: 'learned', confidence: 0.8, projectPath: '/p' },
      ],
    };
    const res = (await call('import', { data })).data as { imported: number; skipped: number };
    expect(res.skipped).toBe(1); // 第一条抛错
    expect(res.imported).toBe(1); // 第二条成功
    // Codex 审计：断言导入的 projectPath/content/source/confidence，错导入不能绿
    expect(db.saveProjectKnowledge).toHaveBeenCalledWith('/p', expect.any(String), '经验一则', 'learned', 0.8);
  });

  it('getMemoryStats 统计分类/来源/总数', async () => {
    db.getAllProjectKnowledge.mockReturnValue([pk({ source: 'learned', createdAt: Date.now() })]);
    db.getAllPreferences.mockReturnValue({ theme: 'dark' });
    const stats = (await call('getMemoryStats')).data as { total: number; learnedCount: number; explicitCount: number };
    expect(stats.total).toBe(2);
    expect(stats.learnedCount).toBe(1);
    expect(stats.explicitCount).toBe(1);
  });
});

describe('light memory 委派', () => {
  it('lightList / lightRead / lightStats 透传', async () => {
    expect((await call('lightList')).data).toEqual(['a.md']);
    expect((await call('lightRead', { filename: 'a.md' })).data).toBe('content');
    expect(light.readMemoryFile).toHaveBeenCalledWith('a.md');
    expect((await call('lightStats')).data).toEqual({ files: 1 });
  });
});

describe('v2 entry 委派', () => {
  it('memoryEntries / memoryExportV2 / memoryRebuildMirror 透传 runtime', async () => {
    expect((await call('memoryEntries')).data).toEqual([{ id: 'e1' }]);
    expect((await call('memoryExportV2')).data).toEqual({ bundle: 'v2' });
    expect((await call('memoryRebuildMirror')).data).toEqual({ rebuilt: 5 });
  });

  // Codex 审计：不能只证 runtime 被调用——必须断言带了正确 (db, payload)，否则丢参仍绿
  it('memoryEntryUpdate 带 (db, payload) 委派；缺 entryId 报错', async () => {
    expect((await call('memoryEntryUpdate', { entryId: 'e1', patch: { x: 1 } })).data).toEqual({ ok: true });
    expect(rt.updateMemoryEntry).toHaveBeenCalledWith(db, { entryId: 'e1', patch: { x: 1 } });
    expect(await call('memoryEntryUpdate', {})).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('entryId') } });
  });

  it('memoryEntryDelete 带 (db, payload) 委派；缺 entryId 报错', async () => {
    expect((await call('memoryEntryDelete', { entryId: 'e9' })).data).toEqual({ ok: true });
    expect(rt.deleteMemoryEntry).toHaveBeenCalledWith(db, { entryId: 'e9' });
    expect(await call('memoryEntryDelete', {})).toMatchObject({ success: false, error: { message: expect.stringContaining('entryId') } });
  });

  it('memoryPack 带 (payload, db) 委派', async () => {
    expect((await call('memoryPack', { ids: ['e1'] })).data).toEqual({ packed: 2 });
    expect(rt.packMemoryEntries).toHaveBeenCalledWith({ ids: ['e1'] }, db);
  });

  it('memoryImportV2DryRun/Apply 要求 schemaVersion 2 bundle，并带 db', async () => {
    const bundle = { schemaVersion: 2, entries: [] };
    expect((await call('memoryImportV2DryRun', { bundle })).data).toEqual({ willImport: 1 });
    expect(rt.dryRunImportMemoryBundleV2).toHaveBeenCalledWith(bundle, db);
    expect((await call('memoryImportV2Apply', { bundle, allowConflicts: true })).data).toEqual({ imported: 1 });
    expect(rt.applyImportMemoryBundleV2).toHaveBeenCalledWith(bundle, db, { allowConflicts: true });
    // 非 v2 bundle → 拒绝
    expect(await call('memoryImportV2DryRun', { bundle: { schemaVersion: 1 } })).toMatchObject({ success: false, error: { message: expect.stringContaining('schemaVersion 2') } });
  });
});

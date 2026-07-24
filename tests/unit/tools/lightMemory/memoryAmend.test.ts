// ============================================================================
// memory_amend —— 定向纠错/遗忘 DB-backed 记忆（配对 memory_search）
// ----------------------------------------------------------------------------
// 背景：写入 memories 表的自动化路径（flush-before-compaction / OCR / 照片归档等）
// 只进不改，模型没法在用户指出"这条记错了"时就地修正或删除。这里补上纠错/遗忘的
// 工具外壳，复用已有的 MemoryRepository.updateMemory/deleteMemory。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  getMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getMemory: dbMocks.getMemory,
    updateMemory: dbMocks.updateMemory,
    deleteMemory: dbMocks.deleteMemory,
  }),
}));

import { memoryAmendModule } from '../../../../src/host/tools/modules/lightMemory/memoryAmend';
import { memoryAmendSchema } from '../../../../src/host/tools/modules/lightMemory/memoryAmend.schema';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import { CORE_TOOLS, DEFERRED_TOOLS_META } from '../../../../src/host/services/toolSearch/deferredTools';

function makeCtx() {
  return {
    abortSignal: { aborted: false } as AbortSignal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as never;
}
const allow = vi.fn().mockResolvedValue({ allow: true });

async function handler() {
  return await memoryAmendModule.createHandler();
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-target',
    type: 'project_knowledge',
    category: 'flush_decision',
    content: 'Original wrong content',
    summary: 'Original wrong content',
    source: 'session_extracted',
    confidence: 1,
    metadata: {},
    accessCount: 0,
    updatedAt: 1,
    ...overrides,
  };
}

describe('memory_amend 工具', () => {
  beforeEach(() => vi.clearAllMocks());

  it('是写工具，不是只读工具', () => {
    expect(memoryAmendSchema.readOnly).toBe(false);
    expect(memoryAmendSchema.permissionLevel).toBe('write');
  });

  it('update：修正已有记录的 content，并重新派生 summary', async () => {
    dbMocks.getMemory.mockReturnValue(record());
    dbMocks.updateMemory.mockReturnValue(record({ content: 'Corrected content' }));

    const result = await (await handler()).execute(
      { id: 'mem-target', action: 'update', content: 'Corrected content' },
      makeCtx(),
      allow,
    );

    expect(result.ok).toBe(true);
    expect(dbMocks.updateMemory).toHaveBeenCalledWith('mem-target', {
      content: 'Corrected content',
      summary: 'Corrected content',
    });
  });

  it('update：超长 content 截断出的 summary 带省略号', async () => {
    dbMocks.getMemory.mockReturnValue(record());
    dbMocks.updateMemory.mockReturnValue(record());
    const longContent = '甲'.repeat(200);

    await (await handler()).execute({ id: 'mem-target', action: 'update', content: longContent }, makeCtx(), allow);

    const summary = dbMocks.updateMemory.mock.calls[0][1].summary as string;
    expect(summary.length).toBeLessThan(longContent.length);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('update：缺 content 判非法，不去打数据库', async () => {
    dbMocks.getMemory.mockReturnValue(record());

    const result = await (await handler()).execute({ id: 'mem-target', action: 'update' }, makeCtx(), allow);

    expect(result.ok).toBe(false);
    expect(dbMocks.updateMemory).not.toHaveBeenCalled();
  });

  it('forget：删除记录', async () => {
    dbMocks.getMemory.mockReturnValue(record());

    const result = await (await handler()).execute({ id: 'mem-target', action: 'forget' }, makeCtx(), allow);

    expect(result.ok).toBe(true);
    expect(dbMocks.deleteMemory).toHaveBeenCalledWith('mem-target');
  });

  it('坏 id：明确报错，不静默', async () => {
    dbMocks.getMemory.mockReturnValue(null);

    const result = await (await handler()).execute({ id: 'nope', action: 'forget' }, makeCtx(), allow);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('NOT_FOUND');
    expect(!result.ok && result.error).toContain('nope');
    expect(dbMocks.deleteMemory).not.toHaveBeenCalled();
    expect(dbMocks.updateMemory).not.toHaveBeenCalled();
  });

  it('未知 action 判非法', async () => {
    dbMocks.getMemory.mockReturnValue(record());

    const result = await (await handler()).execute({ id: 'mem-target', action: 'delete' }, makeCtx(), allow);

    expect(result.ok).toBe(false);
    expect(dbMocks.getMemory).not.toHaveBeenCalled();
  });

  it('空 id 判非法，不去打数据库', async () => {
    const result = await (await handler()).execute({ id: '  ', action: 'forget' }, makeCtx(), allow);

    expect(result.ok).toBe(false);
    expect(dbMocks.getMemory).not.toHaveBeenCalled();
  });
});

describe('memory_amend 登记完整性（防「注册了但模型找不到」复发）', () => {
  beforeEach(() => resetProtocolRegistry());

  it('已注册到 protocol registry', () => {
    expect(getProtocolRegistry().has('memory_amend')).toBe(true);
  });

  it('已登记进 DEFERRED_TOOLS_META 发现索引（ToolSearch 可发现），不进 CORE_TOOLS', () => {
    expect(CORE_TOOLS).not.toContain('memory_amend');
    expect(DEFERRED_TOOLS_META.some((meta) => meta.name === 'memory_amend')).toBe(true);
  });
});

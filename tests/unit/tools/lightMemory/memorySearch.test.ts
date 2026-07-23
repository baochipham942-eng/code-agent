// ============================================================================
// memory_search —— 补上「写得进、取不回」的半截链路
// ----------------------------------------------------------------------------
// image-ocr-search / photo-archive 两个内置 skill 的 allowedTools 一直写着 memory_search，
// ocr_search 插件描述里也写着「先 OCR 历史图片再用 memory_search 检索」，但全仓没有这个工具。
// 检索能力本来就有（databaseService.searchMemories，FTS5 BM25 + LIKE 兜底），这里只补工具外壳。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({ searchMemories: vi.fn() }));
vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ searchMemories: dbMocks.searchMemories }),
}));

import { memorySearchModule } from '../../../../src/host/tools/modules/lightMemory/memorySearch';
import { memorySearchSchema } from '../../../../src/host/tools/modules/lightMemory/memorySearch.schema';

function makeCtx() {
  return {
    abortSignal: { aborted: false } as AbortSignal,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as never;
}
const allow = vi.fn().mockResolvedValue({ allow: true });

/** createHandler 的返回类型是 handler | Promise<handler>，统一 await 掉 */
async function handler() {
  return await memorySearchModule.createHandler();
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    type: 'ocr_result',
    category: 'screenshot',
    content: '发票金额 1280 元，开票日期 2026-07-01',
    source: 'auto_learned',
    confidence: 1,
    metadata: {},
    accessCount: 0,
    updatedAt: 1,
    ...overrides,
  };
}

describe('memory_search 工具', () => {
  beforeEach(() => vi.clearAllMocks());

  it('是只读工具、plan 模式可用（永不进审批闸）', () => {
    expect(memorySearchSchema.readOnly).toBe(true);
    expect(memorySearchSchema.permissionLevel).toBe('read');
    expect(memorySearchSchema.allowInPlanMode).toBe(true);
  });

  it('把命中记录渲染成可读列表，并在 meta 里给结构化结果', async () => {
    dbMocks.searchMemories.mockReturnValue([record()]);
    const result = await (await handler()).execute({ query: '发票' }, makeCtx(), allow);

    expect(result.ok).toBe(true);
    expect(result.ok && result.output).toContain('ocr_result');
    expect(result.ok && result.output).toContain('发票金额 1280 元');
    expect(result.ok ? (result.meta as { count: number }).count : -1).toBe(1);
  });

  it('type / limit 原样透传给已有的检索实现（不另造一套过滤）', async () => {
    dbMocks.searchMemories.mockReturnValue([]);
    await (await handler()).execute(
      { query: '截图', type: 'ocr_result', limit: 3 }, makeCtx(), allow,
    );
    expect(dbMocks.searchMemories).toHaveBeenCalledWith('截图', expect.objectContaining({ type: 'ocr_result', limit: 3 }));
  });

  it('limit 越界收敛到 1..50，非法值回落默认', async () => {
    dbMocks.searchMemories.mockReturnValue([]);
    const h = await handler();
    await h.execute({ query: 'x', limit: 999 }, makeCtx(), allow);
    expect(dbMocks.searchMemories.mock.calls[0][1].limit).toBe(50);
    await h.execute({ query: 'x', limit: 'abc' }, makeCtx(), allow);
    expect(dbMocks.searchMemories.mock.calls[1][1].limit).toBe(10);
  });

  it('超长正文按字数截断，别把上下文窗口打爆', async () => {
    dbMocks.searchMemories.mockReturnValue([record({ content: '甲'.repeat(2000) })]);
    const result = await (await handler()).execute({ query: '甲' }, makeCtx(), allow);
    expect(result.ok && result.output.length).toBeLessThan(500);
    expect(result.ok && result.output).toContain('…');
  });

  it('搜不到时给出明确引导，不返回空串', async () => {
    dbMocks.searchMemories.mockReturnValue([]);
    const result = await (await handler()).execute({ query: '不存在' }, makeCtx(), allow);
    expect(result.ok && result.output.length).toBeGreaterThan(10);
    expect(result.ok && result.output).toContain('MemoryRead');
  });

  it('空 query 直接判非法，不去打数据库', async () => {
    const result = await (await handler()).execute({ query: '   ' }, makeCtx(), allow);
    expect(result.ok).toBe(false);
    expect(dbMocks.searchMemories).not.toHaveBeenCalled();
  });
});

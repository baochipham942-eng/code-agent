// ============================================================================
// libraryPins - pinned 资料索引块 + cache key 指纹（Batch 2 L2）
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryItem, SessionContextPin } from '../../../src/shared/contract/library';

const mocks = vi.hoisted(() => ({
  getPin: vi.fn(),
  getPinnedItems: vi.fn(),
}));

vi.mock('../../../src/host/services/library/libraryService', () => ({
  getLibraryService: () => ({
    getPin: mocks.getPin,
    getPinnedItems: mocks.getPinnedItems,
  }),
}));

vi.mock('../../../src/host/agent/runtime/contextAssembly/promptBudget', () => ({
  appendPromptBlockWithinBudget: (prompt: string, block: string) => `${prompt}\n${block}`,
}));

import {
  appendPinnedLibraryPromptBlock,
  buildPinnedLibraryBlock,
  getSessionPinFingerprint,
} from '../../../src/host/agent/runtime/contextAssembly/libraryPins';
import { listMemoryInjectionTraces } from '../../../src/host/memory/memoryInjectionTrace';

function item(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'lib_1',
    projectId: 'proj_1',
    title: 'Brief.pdf',
    kind: 'upload',
    pathOrUri: '/data/library/proj_1/Brief.pdf',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('getSessionPinFingerprint', () => {
  beforeEach(() => vi.clearAllMocks());

  it('无 pin → no-pins；有 pin → addedAt+itemIds 指纹；pin 变更指纹必变', () => {
    mocks.getPin.mockReturnValue({ sessionId: 's', itemIds: [], addedAt: 0 } satisfies SessionContextPin);
    expect(getSessionPinFingerprint('s')).toBe('no-pins');

    mocks.getPin.mockReturnValue({ sessionId: 's', itemIds: ['a', 'b'], addedAt: 100 });
    const f1 = getSessionPinFingerprint('s');
    mocks.getPin.mockReturnValue({ sessionId: 's', itemIds: ['a'], addedAt: 200 });
    const f2 = getSessionPinFingerprint('s');
    expect(f1).not.toBe(f2);
  });

  it('服务抛错（DB 未就绪）降级为 no-pins 不抛出', () => {
    mocks.getPin.mockImplementation(() => { throw new Error('Database not initialized'); });
    expect(getSessionPinFingerprint('s')).toBe('no-pins');
  });
});

describe('buildPinnedLibraryBlock', () => {
  beforeEach(() => vi.clearAllMocks());

  it('无 pin 返回 null', () => {
    mocks.getPinnedItems.mockReturnValue([]);
    expect(buildPinnedLibraryBlock('s')).toEqual({ block: null, count: 0 });
  });

  it('索引块含标题/路径/摘要/标签与来源标注要求，不含正文', () => {
    mocks.getPinnedItems.mockReturnValue([
      item({ summary: '三季度竞品对比', tags: ['素材', '证据'] }),
      item({ id: 'lib_2', title: '规范', kind: 'external_ref', pathOrUri: 'https://example.com/spec' }),
    ]);
    const { block, count } = buildPinnedLibraryBlock('s');

    expect(count).toBe(2);
    expect(block).toContain('<pinned_library_resources>');
    expect(block).toContain('Brief.pdf');
    expect(block).toContain('/data/library/proj_1/Brief.pdf');
    expect(block).toContain('三季度竞品对比');
    expect(block).toContain('素材 / 证据');
    expect(block).toContain('https://example.com/spec');
    expect(block).toContain('标注来源');
    expect(block).toContain('正文未注入');
  });

  it('服务抛错降级为 null 不抛出', () => {
    mocks.getPinnedItems.mockImplementation(() => { throw new Error('boom'); });
    expect(buildPinnedLibraryBlock('s')).toEqual({ block: null, count: 0 });
  });
});

describe('appendPinnedLibraryPromptBlock', () => {
  beforeEach(() => vi.clearAllMocks());

  function ctx(sessionId: string) {
    return { runtime: { sessionId } } as never;
  }

  it('无 pin 时原样返回，不记 trace 不进 appendedBlocks', () => {
    mocks.getPinnedItems.mockReturnValue([]);
    const blocks = new Map<string, string>();
    const before = listMemoryInjectionTraces({ sessionId: 'sess-empty' }).length;

    expect(appendPinnedLibraryPromptBlock('base', ctx('sess-empty'), blocks)).toBe('base');
    expect(blocks.size).toBe(0);
    expect(listMemoryInjectionTraces({ sessionId: 'sess-empty' }).length).toBe(before);
  });

  it('有 pin 时追加块 + 记 trace + 登记 appendedBlocks', () => {
    mocks.getPinnedItems.mockReturnValue([item()]);
    const blocks = new Map<string, string>();

    const result = appendPinnedLibraryPromptBlock('base', ctx('sess-pinned'), blocks);

    expect(result).toContain('base');
    expect(result).toContain('<pinned_library_resources>');
    expect(blocks.get('library pins')).toContain('Brief.pdf');

    const traces = listMemoryInjectionTraces({ sessionId: 'sess-pinned' });
    expect(traces[0]?.blockType).toBe('library_pins');
    expect(traces[0]?.injected).toBe(true);
    expect(traces[0]?.count).toBe(1);
  });
});

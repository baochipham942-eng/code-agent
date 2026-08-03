// @vitest-environment jsdom
// ============================================================================
// @ 触发面板（任务 14/15）：分组模型 + 资料库 pin + 键盘导航
// ============================================================================

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryItem } from '../../../src/shared/contract/library';
import {
  buildFileRows,
  buildLibraryRows,
  deriveFileDir,
  flattenAtMentionRows,
  wrapIndex,
} from '../../../src/renderer/components/features/chat/ChatInput/atMentionPanelModel';

const mocks = vi.hoisted(() => ({
  listLibraryItems: vi.fn(),
  getSessionPin: vi.fn(),
  setSessionPin: vi.fn(),
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: mocks.listLibraryItems,
  getSessionPin: mocks.getSessionPin,
  setSessionPin: mocks.setSessionPin,
}));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: mocks.toast }));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});

import { useAtMentionPanel } from '../../../src/renderer/components/features/chat/ChatInput/useAtMentionPanel';

function libraryItem(id: string, projectId: string | null, title = id): LibraryItem {
  return {
    id,
    projectId,
    title,
    kind: 'upload',
    pathOrUri: `/lib/${id}.md`,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function keyEvent(key: string): React.KeyboardEvent<HTMLTextAreaElement> {
  return {
    key,
    preventDefault: vi.fn(),
    nativeEvent: { isComposing: false, keyCode: key === 'Enter' ? 13 : 0 },
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
}

describe('atMentionPanelModel', () => {
  it('资料库组只保留 本项目 ∪ 全局 候选，并按 query 过滤', () => {
    const items = [
      libraryItem('p1', 'proj-1', '发布 checklist'),
      libraryItem('p2', 'proj-2', '别的项目资料'),
      libraryItem('g1', null, '全局品牌套件'),
    ];
    const rows = buildLibraryRows(items, 'proj-1', new Set(), '');
    expect(rows.map((row) => row.item.id)).toEqual(['p1', 'g1']);

    const filtered = buildLibraryRows(items, 'proj-1', new Set(), '品牌');
    expect(filtered.map((row) => row.item.id)).toEqual(['g1']);
  });

  it('已 pin 的条目行带 pinned 选中态，且每组封顶 8 条', () => {
    const items = Array.from({ length: 10 }, (_, i) => libraryItem(`g${i}`, null));
    const rows = buildLibraryRows(items, null, new Set(['g3']), '');
    expect(rows).toHaveLength(8);
    expect(rows.find((row) => row.item.id === 'g3')?.pinned).toBe(true);
    expect(rows.find((row) => row.item.id === 'g0')?.pinned).toBe(false);
  });

  it('文件组沿用名称子串过滤并推导所在目录', () => {
    const rows = buildFileRows([
      { path: 'src/foo/bar.ts', name: 'bar.ts', isDirectory: false },
      { path: 'README.md', name: 'README.md', isDirectory: false },
      { path: 'src/foo', name: 'foo', isDirectory: true },
    ], 'bar');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'bar.ts', dir: 'src/foo', isDirectory: false });
    expect(deriveFileDir('README.md', 'README.md')).toBe('');
  });

  it('键盘导航在平铺序列上跨组循环', () => {
    const libraryRows = buildLibraryRows([libraryItem('g1', null)], null, new Set(), '');
    const fileRows = buildFileRows([
      { path: 'a.ts', name: 'a.ts', isDirectory: false },
      { path: 'b.ts', name: 'b.ts', isDirectory: false },
    ], '');
    const flat = flattenAtMentionRows(libraryRows, fileRows);
    expect(flat.map((row) => row.kind)).toEqual(['library', 'file', 'file']);
    expect(wrapIndex(2, 1, flat.length)).toBe(0);
    expect(wrapIndex(0, -1, flat.length)).toBe(2);
  });
});

describe('useAtMentionPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.listLibraryItems.mockResolvedValue([
      libraryItem('p1', 'proj-1', '发布 checklist'),
      libraryItem('g1', null, '全局品牌套件'),
    ]);
    mocks.getSessionPin.mockResolvedValue({ sessionId: 'session-1', itemIds: ['g1'] });
    mocks.setSessionPin.mockResolvedValue({ sessionId: 'session-1', itemIds: [] });
    (window as { domainAPI?: unknown }).domainAPI = {
      invoke: vi.fn().mockResolvedValue({
        success: true,
        data: [
          { name: 'alpha.ts', path: 'src/alpha.ts', isDirectory: false },
          { name: 'docs', path: 'docs', isDirectory: true },
        ],
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(onFileSelect = vi.fn()) {
    return renderHook(() => useAtMentionPanel({
      sessionId: 'session-1',
      projectId: 'proj-1',
      onFileSelect,
    }));
  }

  async function openPanel(result: { current: ReturnType<typeof useAtMentionPanel> }) {
    await act(async () => {
      result.current.search('@', 1);
      await vi.advanceTimersByTimeAsync(250);
    });
  }

  it('打开后同时给出资料库组与工作区文件组，pin 态来自 getSessionPin', async () => {
    const { result } = setup();
    await openPanel(result);

    expect(result.current.isOpen).toBe(true);
    expect(result.current.libraryRows.map((row) => [row.item.id, row.pinned])).toEqual([['p1', false], ['g1', true]]);
    expect(result.current.fileRows.map((row) => row.name)).toEqual(['alpha.ts', 'docs']);
    expect(result.current.flatRows).toHaveLength(4);
  });

  it('↑↓ 跨组循环，Enter 选中资料库行 = 切换 pin（乐观更新），选中文件行 = 插入并关闭', async () => {
    const onFileSelect = vi.fn();
    const { result } = setup(onFileSelect);
    await openPanel(result);

    // 从 0 向上 = 循环到最后一行（文件 docs）
    act(() => { result.current.handleKeyDown(keyEvent('ArrowUp')); });
    expect(result.current.selectedIndex).toBe(3);
    act(() => { result.current.handleKeyDown(keyEvent('ArrowDown')); });
    expect(result.current.selectedIndex).toBe(0);

    // Enter 在资料库行：pin 切换且面板保持打开
    act(() => { result.current.handleKeyDown(keyEvent('Enter')); });
    expect(mocks.setSessionPin).toHaveBeenCalledWith('session-1', ['g1', 'p1']);
    expect(result.current.isOpen).toBe(true);
    expect(result.current.libraryRows[0]?.pinned).toBe(true);

    // 移到文件行 Enter：插入路径并关闭面板
    act(() => { result.current.handleKeyDown(keyEvent('ArrowDown')); });
    act(() => { result.current.handleKeyDown(keyEvent('ArrowDown')); });
    act(() => { result.current.handleKeyDown(keyEvent('Enter')); });
    // 文件行选中把整行交给组件（文件 → 内联 chip + 附件；目录 → @path 文本）
    expect(onFileSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/alpha.ts', name: 'alpha.ts', isDirectory: false }));
    expect(result.current.isOpen).toBe(false);
  });

  it('IME 组合中的 Enter 不触发选择', async () => {
    const { result } = setup();
    await openPanel(result);

    const imeEnter = {
      key: 'Enter',
      preventDefault: vi.fn(),
      nativeEvent: { isComposing: true, keyCode: 229 },
    } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
    const handled = result.current.handleKeyDown(imeEnter);
    expect(handled).toBe(false);
    expect(mocks.setSessionPin).not.toHaveBeenCalled();
  });

  it('Esc 关闭后面板不因同一段文本再次弹开', async () => {
    const { result } = setup();
    await openPanel(result);

    act(() => { result.current.handleKeyDown(keyEvent('Escape')); });
    expect(result.current.isOpen).toBe(false);

    await act(async () => {
      result.current.search('@', 1);
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(result.current.isOpen).toBe(false);

    // 文本变了（继续输入 query）则重新打开
    await act(async () => {
      result.current.search('@a', 2);
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(result.current.isOpen).toBe(true);
  });

  it('pin 写库失败时回滚选中态并提示', async () => {
    mocks.setSessionPin.mockRejectedValueOnce(new Error('ipc down'));
    const { result } = setup();
    await openPanel(result);

    act(() => { result.current.handleKeyDown(keyEvent('Enter')); });
    expect(result.current.libraryRows[0]?.pinned).toBe(true);
    await act(async () => { await Promise.resolve(); });
    expect(result.current.libraryRows[0]?.pinned).toBe(false);
    expect(mocks.toast.error).toHaveBeenCalled();
  });
});

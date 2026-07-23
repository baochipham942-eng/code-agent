// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIBRARY_ITEM_KINDS, type LibraryItem } from '../../../src/shared/contract/library';
import type { BrandContract, BrandMeta } from '../../../src/shared/contract/brandContract';

const listLibraryItems = vi.fn<() => Promise<LibraryItem[]>>();
const deleteLibraryItem = vi.fn().mockResolvedValue(undefined);
const importLibraryFiles = vi.fn().mockResolvedValue({ items: [], errors: [] });
const updateLibraryItem = vi.fn();
const listBrands = vi.fn<() => Promise<{ brands: BrandMeta[]; activeId?: string }>>();
const readBrand = vi.fn<() => Promise<BrandContract | null>>();
const saveBrand = vi.fn<() => Promise<string | null>>();
const deleteBrand = vi.fn().mockResolvedValue(true);
const setActiveBrand = vi.fn().mockResolvedValue(true);
const extractBrandFromImage = vi.fn();

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: (...args: unknown[]) => listLibraryItems(...(args as [])),
  deleteLibraryItem: (...args: unknown[]) => deleteLibraryItem(...(args as [])),
  importLibraryFiles: (...args: unknown[]) => importLibraryFiles(...(args as [])),
  updateLibraryItem: (...args: unknown[]) => updateLibraryItem(...(args as [])),
}));

vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjects: vi.fn().mockResolvedValue([{ id: 'proj_1', name: '示例项目', status: 'active', createdAt: 1, updatedAt: 1 }]),
}));

vi.mock('../../../src/renderer/components/design/designFiles', () => ({
  listBrands: (...args: unknown[]) => listBrands(...(args as [])),
  readBrand: (...args: unknown[]) => readBrand(...(args as [])),
  saveBrand: (...args: unknown[]) => saveBrand(...(args as [])),
  deleteBrand: (...args: unknown[]) => deleteBrand(...(args as [])),
  setActiveBrand: (...args: unknown[]) => setActiveBrand(...(args as [])),
  extractBrandFromImage: (...args: unknown[]) => extractBrandFromImage(...(args as [])),
}));

import { LibraryPanel } from '../../../src/renderer/components/features/knowledge/LibraryPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

function makeItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'lib_1',
    projectId: null,
    title: 'Brief.pdf',
    kind: 'upload',
    pathOrUri: '/data/library/global/Brief.pdf',
    tags: ['素材'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSessionStore.setState({ sessions: [] });
});

beforeEach(() => {
  listBrands.mockResolvedValue({ brands: [] });
  readBrand.mockResolvedValue(null);
  saveBrand.mockResolvedValue('brand-new');
});

describe('LibraryPanel', () => {
  it('空库渲染空态文案', async () => {
    listLibraryItems.mockResolvedValue([]);
    render(<LibraryPanel />);
    await waitFor(() => {
      expect(screen.getByText(/资料库还没有条目/)).toBeTruthy();
    });
    expect(listLibraryItems).toHaveBeenCalledWith({ projectId: null });
  });

  it('渲染条目标题/标签，切换作用域按项目重新加载', async () => {
    listLibraryItems.mockResolvedValue([makeItem()]);
    render(<LibraryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Brief.pdf')).toBeTruthy();
    });
    expect(screen.getByText('素材')).toBeTruthy();

    const select = await screen.findByTestId('library-scope-select') as HTMLSelectElement;
    await waitFor(() => {
      expect(select.querySelectorAll('option').length).toBe(2);
    });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(select, { target: { value: 'proj_1' } });
    await waitFor(() => {
      expect(listLibraryItems).toHaveBeenCalledWith({ projectId: 'proj_1' });
    });
  });

  it('按会话标题分组，找不到会话标题时归入未分组而不暴露会话 id', async () => {
    listLibraryItems.mockResolvedValue([
      makeItem({ id: 'lib_alpha', title: 'Alpha', sourceSessionId: 'session_alpha' }),
      makeItem({ id: 'lib_beta', title: 'Beta', sourceSessionId: 'session_beta' }),
      makeItem({ id: 'lib_missing', title: 'Missing', sourceSessionId: 'session_missing' }),
    ]);
    useSessionStore.setState({ sessions: [
      { id: 'session_alpha', title: '需求梳理' },
      { id: 'session_beta', title: '交付复盘' },
    ] as never });
    render(<LibraryPanel />);

    await screen.findByText('需求梳理');
    expect(screen.getByTestId('library-group-session_alpha')).toBeTruthy();
    expect(screen.getByTestId('library-group-session_beta')).toBeTruthy();
    expect(screen.getByTestId('library-group-ungrouped')).toBeTruthy();
    expect(screen.getByText('未分组')).toBeTruthy();
    expect(screen.queryByText('session_missing')).toBeNull();
  });

  it('按 contract 推导类型选项，筛选后只显示对应条目', async () => {
    const { fireEvent } = await import('@testing-library/react');
    listLibraryItems.mockResolvedValue([
      makeItem({ id: 'upload', kind: 'upload', title: '上传条目' }),
      makeItem({ id: 'artifact', kind: 'artifact', title: '产物条目' }),
    ]);
    render(<LibraryPanel />);
    const filter = await screen.findByTestId('library-kind-filter') as HTMLSelectElement;
    expect(filter.querySelectorAll('option')).toHaveLength(LIBRARY_ITEM_KINDS.length + 1);
    fireEvent.change(filter, { target: { value: 'artifact' } });
    await screen.findByText('产物条目');
    expect(document.querySelector('[data-library-item="artifact"]')).toBeTruthy();
    expect(document.querySelector('[data-library-item="upload"]')).toBeNull();
  });

  it('品牌套件作为并列分区列出真实品牌，且不改变资料条目的筛选和计数', async () => {
    const { fireEvent } = await import('@testing-library/react');
    listLibraryItems.mockResolvedValue([makeItem()]);
    listBrands.mockResolvedValue({
      brands: [{ id: 'porsche-digital', name: 'Porsche 数字品牌', updatedAt: 200 }],
      activeId: 'porsche-digital',
    });
    render(<LibraryPanel />);

    await screen.findByText('Brief.pdf');
    const filter = screen.getByTestId('library-kind-filter') as HTMLSelectElement;
    expect(filter.querySelectorAll('option')).toHaveLength(LIBRARY_ITEM_KINDS.length + 1);
    expect(screen.getByText('1 条')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '品牌套件' }));
    expect(await screen.findByText('Porsche 数字品牌')).toBeTruthy();
    expect(listBrands).toHaveBeenCalledTimes(1);
    expect(listLibraryItems).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: '资料条目' }));
    expect(await screen.findByText('Brief.pdf')).toBeTruthy();
    expect((screen.getByTestId('library-kind-filter') as HTMLSelectElement).querySelectorAll('option'))
      .toHaveLength(LIBRARY_ITEM_KINDS.length + 1);
    expect(screen.getByText('1 条')).toBeTruthy();
  });

  it('从品牌套件分区新建品牌仍调用 saveBrand 契约', async () => {
    const { fireEvent } = await import('@testing-library/react');
    listLibraryItems.mockResolvedValue([]);
    render(<LibraryPanel />);

    fireEvent.click(screen.getByRole('tab', { name: '品牌套件' }));
    await waitFor(() => expect(listBrands).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '新建品牌' }));
    fireEvent.change(screen.getByLabelText('品牌名称'), { target: { value: '资料库新品牌' } });
    fireEvent.click(screen.getByRole('button', { name: '保存品牌' }));

    await waitFor(() => {
      expect(saveBrand).toHaveBeenCalledWith(expect.objectContaining({
        id: '',
        name: '资料库新品牌',
        source: 'manual',
      }));
    });
  });

  it('搜索可按摘要和标签命中', async () => {
    const { fireEvent } = await import('@testing-library/react');
    listLibraryItems.mockResolvedValue([
      makeItem({ id: 'summary', title: '方案', summary: '包含发布节奏', tags: ['设计'] }),
      makeItem({ id: 'tag', title: '素材', tags: ['关键证据'] }),
    ]);
    render(<LibraryPanel />);
    const search = await screen.findByTestId('library-search');
    fireEvent.change(search, { target: { value: '发布节奏' } });
    expect(await screen.findByText('方案')).toBeTruthy();
    expect(screen.queryByText('素材')).toBeNull();
    fireEvent.change(search, { target: { value: '关键证据' } });
    expect(await screen.findByText('素材')).toBeTruthy();
    expect(screen.queryByText('方案')).toBeNull();
  });

  it('删除是两段式：第一次点进入确认态，第二次才真删', async () => {
    const { fireEvent } = await import('@testing-library/react');
    listLibraryItems.mockResolvedValue([makeItem()]);
    render(<LibraryPanel />);
    const button = await screen.findByTestId('library-delete-lib_1');

    fireEvent.click(button);
    await waitFor(() => {
      expect(button.getAttribute('title')).toBe('再点一次确认删除');
    });
    expect(deleteLibraryItem).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => {
      expect(deleteLibraryItem).toHaveBeenCalledWith('lib_1');
    });
  });

  it('编辑标题和标签后保存，列表原地显示返回的新条目', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const original = makeItem();
    const updated = makeItem({ title: '更新后的 Brief', tags: ['需求', '定稿'], summary: '新的摘要' });
    listLibraryItems.mockResolvedValue([original]);
    updateLibraryItem.mockResolvedValue(updated);
    render(<LibraryPanel />);

    fireEvent.click(await screen.findByTestId('library-edit-lib_1'));
    fireEvent.change(screen.getByTestId('library-edit-title'), { target: { value: '更新后的 Brief' } });
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: '需求， 定稿,  ' } });
    fireEvent.click(screen.getByTestId('library-edit-save'));

    await waitFor(() => {
      expect(updateLibraryItem).toHaveBeenCalledWith('lib_1', {
        title: '更新后的 Brief',
        tags: ['需求', '定稿'],
        summary: '',
      });
    });
    await waitFor(() => {
      expect(screen.getByText('更新后的 Brief')).toBeTruthy();
    });
  });

  it('标题清空时保存按钮禁用', async () => {
    const { fireEvent } = await import('@testing-library/react');
    listLibraryItems.mockResolvedValue([makeItem()]);
    render(<LibraryPanel />);

    fireEvent.click(await screen.findByTestId('library-edit-lib_1'));
    fireEvent.change(screen.getByTestId('library-edit-title'), { target: { value: '' } });
    expect(screen.getByTestId('library-edit-save')).toHaveProperty('disabled', true);
  });

  it('关闭按钮复位 appStore 面板开关', async () => {
    listLibraryItems.mockResolvedValue([]);
    useAppStore.getState().setShowLibraryPanel(true);
    render(<LibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('library-panel')).toBeTruthy();
    });
    screen.getByLabelText('关闭').click();
    expect(useAppStore.getState().showLibraryPanel).toBe(false);
  });

});

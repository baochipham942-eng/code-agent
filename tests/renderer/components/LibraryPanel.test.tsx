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
    // 默认带来源会话，按推导口径落入「AI 生成」tab（默认 tab），减少各用例的先置点击
    sourceSessionId: 'session_default',
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
  it('keeps the single-line header actions compact and the upload label unbroken', async () => {
    listLibraryItems.mockResolvedValue([]);
    render(<LibraryPanel />);

    const search = await screen.findByTestId('library-search');
    const upload = screen.getByTestId('library-upload');

    expect(search.classList.contains('w-40')).toBe(true);
    expect(search.classList.contains('min-w-0')).toBe(true);
    expect(upload.classList.contains('shrink-0')).toBe(true);
    expect(upload.classList.contains('whitespace-nowrap')).toBe(true);
    expect(upload.textContent).toBe('上传文件');
  });

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

  it('类型 chips 按 contract 推导，点击后只显示对应条目', async () => {
    const { fireEvent } = await import('@testing-library/react');
    listLibraryItems.mockResolvedValue([
      makeItem({ id: 'upload', kind: 'upload', title: '上传条目' }),
      makeItem({ id: 'artifact', kind: 'artifact', title: '产物条目' }),
    ]);
    render(<LibraryPanel />);
    await screen.findByText('上传条目');
    // chips 数量 = 全部 + LIBRARY_ITEM_KINDS
    expect(screen.getByTestId('library-kind-chip-all')).toBeTruthy();
    for (const kind of LIBRARY_ITEM_KINDS) {
      expect(screen.getByTestId(`library-kind-chip-${kind}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByTestId('library-kind-chip-artifact'));
    await screen.findByText('产物条目');
    expect(document.querySelector('[data-library-item="artifact"]')).toBeTruthy();
    expect(document.querySelector('[data-library-item="upload"]')).toBeNull();
  });

  it('单行工具条：不再有来源 tab，类型 chips 与搜索/品牌套件同行（2026-07-27 拍板：两行 tab 太复杂）', async () => {
    listLibraryItems.mockResolvedValue([
      makeItem({ id: 'lib_ai', title: '会话产物', kind: 'artifact', sourceSessionId: 'session_a' }),
      makeItem({ id: 'lib_manual', title: '手动上传.pdf', kind: 'upload', sourceSessionId: undefined }),
    ]);
    render(<LibraryPanel />);

    // 来源 tab 整行已删：两类条目现在同屏可见，不再被「AI 生成」默认档挡住
    await screen.findByText('会话产物');
    await screen.findByText('手动上传.pdf');
    expect(screen.queryByTestId('library-source-ai')).toBeNull();
    expect(screen.queryByTestId('library-source-uploads')).toBeNull();
    expect(screen.queryByTestId('library-source-favorites')).toBeNull();

    // 类型 chips / 搜索 / 品牌套件在同一条工具行里
    const toolbar = screen.getByTestId('library-toolbar');
    expect(toolbar.querySelector('[data-testid="library-kind-chips"]')).not.toBeNull();
    expect(toolbar.querySelector('[data-testid="library-search"]')).not.toBeNull();
    expect(toolbar.querySelector('[data-testid="library-brands-entry"]')).not.toBeNull();
  });

  // 2026-07-27 审美关：「记忆」从资料库撤走（记忆偏个人设置），家在设置 → 记忆。
  // 2026-08-02 整窗页 KnowledgeMemoryPanel 退役，资料库不该再有第二个入口。
  it('不再有「记忆」tab', async () => {
    listLibraryItems.mockResolvedValue([makeItem()]);
    render(<LibraryPanel />);
    await screen.findByText('Brief.pdf');

    expect(screen.queryByTestId('library-tab-memory')).toBeNull();
  });

  it('品牌套件从右侧次级入口进入，列出真实品牌且不改变资料条目筛选和计数', async () => {
    const { fireEvent } = await import('@testing-library/react');
    listLibraryItems.mockResolvedValue([makeItem()]);
    listBrands.mockResolvedValue({
      brands: [{ id: 'porsche-digital', name: 'Porsche 数字品牌', updatedAt: 200 }],
      activeId: 'porsche-digital',
    });
    render(<LibraryPanel />);

    await screen.findByText('Brief.pdf');
    expect(screen.getByTestId('library-kind-chip-artifact')).toBeTruthy();
    expect(screen.getByText('1 条')).toBeTruthy();

    fireEvent.click(screen.getByTestId('library-brands-entry'));
    expect(await screen.findByText('Porsche 数字品牌')).toBeTruthy();
    expect(listBrands).toHaveBeenCalledTimes(1);
    expect(listLibraryItems).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('library-brands-back'));
    expect(await screen.findByText('Brief.pdf')).toBeTruthy();
    expect(screen.getByTestId('library-kind-chip-artifact')).toBeTruthy();
    expect(screen.getByText('1 条')).toBeTruthy();
  });

  it('从品牌套件入口新建品牌仍调用 saveBrand 契约', async () => {
    const { fireEvent } = await import('@testing-library/react');
    listLibraryItems.mockResolvedValue([]);
    render(<LibraryPanel />);

    fireEvent.click(screen.getByTestId('library-brands-entry'));
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

  // 批 C：资料库改 inline 二级页（侧栏常驻，右侧内容区渲染），
  // 返回语义从「返回应用」按钮改为侧栏直接切换，页内不再画返回按钮。
  it('是 inline 二级页：不接管整窗、不画「返回应用」按钮', async () => {
    listLibraryItems.mockResolvedValue([]);
    useAppStore.getState().setShowLibraryPanel(true);
    render(<LibraryPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('library-panel')).toBeTruthy();
    });
    expect(screen.getByTestId('library-panel').getAttribute('data-page-variant')).toBe('inline');
    expect(screen.queryByTestId('full-screen-page-back')).toBeNull();
    // 返回靠 appStore 的统一让位动作（switchSession/新建会话经它收口）
    useAppStore.getState().closeSecondaryPages();
    expect(useAppStore.getState().showLibraryPanel).toBe(false);
  });

});

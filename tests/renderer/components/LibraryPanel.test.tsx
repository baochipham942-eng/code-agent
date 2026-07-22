// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryItem } from '../../../src/shared/contract/library';

const listLibraryItems = vi.fn<() => Promise<LibraryItem[]>>();
const deleteLibraryItem = vi.fn().mockResolvedValue(undefined);
const importLibraryFiles = vi.fn().mockResolvedValue({ items: [], errors: [] });
const updateLibraryItem = vi.fn();

vi.mock('../../../src/renderer/services/libraryClient', () => ({
  listLibraryItems: (...args: unknown[]) => listLibraryItems(...(args as [])),
  deleteLibraryItem: (...args: unknown[]) => deleteLibraryItem(...(args as [])),
  importLibraryFiles: (...args: unknown[]) => importLibraryFiles(...(args as [])),
  updateLibraryItem: (...args: unknown[]) => updateLibraryItem(...(args as [])),
}));

vi.mock('../../../src/renderer/services/projectClient', () => ({
  listProjects: vi.fn().mockResolvedValue([{ id: 'proj_1', name: '示例项目', status: 'active', createdAt: 1, updatedAt: 1 }]),
}));

import { LibraryPanel } from '../../../src/renderer/components/features/knowledge/LibraryPanel';
import { useAppStore } from '../../../src/renderer/stores/appStore';

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

// ============================================================================
// Capture Store - 知识库采集内容状态管理
// ============================================================================

import { create } from 'zustand';
import { IPC_DOMAINS } from '@shared/ipc';
import type { CaptureItem, CaptureRequest, CaptureSearchResult, CaptureStats, CaptureSource } from '@shared/types/capture';

interface CaptureState {
  items: CaptureItem[];
  searchResults: CaptureSearchResult[];
  stats: CaptureStats | null;
  isLoading: boolean;
  searchQuery: string;
  filterSource: CaptureSource | 'all';
  selectedItemId: string | null;

  // 手动添加对话框
  isAddDialogOpen: boolean;
  setAddDialogOpen: (open: boolean) => void;

  // 文件导入
  isImporting: boolean;

  // Actions
  setSearchQuery: (query: string) => void;
  setFilterSource: (source: CaptureSource | 'all') => void;
  setSelectedItemId: (id: string | null) => void;
  loadItems: () => Promise<void>;
  searchItems: (query: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  loadStats: () => Promise<void>;
  captureItem: (request: CaptureRequest) => Promise<boolean>;
  importFiles: () => Promise<void>;
}

export const useCaptureStore = create<CaptureState>((set, get) => ({
  items: [],
  searchResults: [],
  stats: null,
  isLoading: false,
  searchQuery: '',
  filterSource: 'all',
  selectedItemId: null,
  isAddDialogOpen: false,
  isImporting: false,

  setAddDialogOpen: (open) => set({ isAddDialogOpen: open }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setFilterSource: (source) => set({ filterSource: source }),
  setSelectedItemId: (id) => set({ selectedItemId: id }),

  loadItems: async () => {
    if (!window.domainAPI) return;
    set({ isLoading: true });
    try {
      const { filterSource } = get();
      const payload: Record<string, unknown> = { limit: 100 };
      if (filterSource !== 'all') {
        payload.source = filterSource;
      }
      const result = await window.domainAPI.invoke<CaptureItem[]>(
        IPC_DOMAINS.CAPTURE,
        'list',
        payload,
      );
      if (result?.success) {
        set({ items: result.data || [] });
      }
    } catch (error) {
      console.error('Failed to load capture items', error);
    } finally {
      set({ isLoading: false });
    }
  },

  searchItems: async (query: string) => {
    if (!window.domainAPI) return;
    if (!query.trim()) {
      set({ searchResults: [] });
      return;
    }
    set({ isLoading: true });
    try {
      const result = await window.domainAPI.invoke<CaptureSearchResult[]>(
        IPC_DOMAINS.CAPTURE,
        'search',
        { query, topK: 20 },
      );
      if (result?.success) {
        set({ searchResults: result.data || [] });
      }
    } catch (error) {
      console.error('Failed to search capture items', error);
    } finally {
      set({ isLoading: false });
    }
  },

  deleteItem: async (id: string) => {
    if (!window.domainAPI) return;
    try {
      await window.domainAPI.invoke(
        IPC_DOMAINS.CAPTURE,
        'delete',
        { id },
      );
      set(state => ({
        items: state.items.filter(i => i.id !== id),
        selectedItemId: state.selectedItemId === id ? null : state.selectedItemId,
      }));
    } catch (error) {
      console.error('Failed to delete capture item', error);
    }
  },

  loadStats: async () => {
    if (!window.domainAPI) return;
    try {
      const result = await window.domainAPI.invoke<CaptureStats>(
        IPC_DOMAINS.CAPTURE,
        'stats',
      );
      if (result?.success) {
        set({ stats: result.data });
      }
    } catch (error) {
      console.error('Failed to load capture stats', error);
    }
  },

  captureItem: async (request: CaptureRequest) => {
    if (!window.domainAPI) return false;
    try {
      const result = await window.domainAPI.invoke<CaptureItem>(
        IPC_DOMAINS.CAPTURE,
        'capture',
        request,
      );
      if (result?.success) {
        // 刷新列表和统计
        await get().loadItems();
        await get().loadStats();
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to capture item', error);
      return false;
    }
  },

  importFiles: async () => {
    if (!window.domainAPI) return;

    // 1. 打开文件选择对话框
    const selectResult = await window.domainAPI.invoke<string[]>(
      IPC_DOMAINS.CAPTURE,
      'selectFiles',
    );
    if (!selectResult?.success || !selectResult.data?.length) return;

    // 2. 导入选中的文件
    set({ isImporting: true });
    try {
      await window.domainAPI.invoke(
        IPC_DOMAINS.CAPTURE,
        'importFiles',
        { filePaths: selectResult.data },
      );
      // 3. 刷新列表和统计
      await get().loadItems();
      await get().loadStats();
    } catch (error) {
      console.error('Failed to import files', error);
    } finally {
      set({ isImporting: false });
    }
  },
}));

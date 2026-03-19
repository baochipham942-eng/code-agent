// ============================================================================
// Explorer Store - File Explorer Panel State Management
// ============================================================================

import { create } from 'zustand';
import type { FileInfo } from '@shared/types';

export interface ExplorerTab {
  id: string;
  rootPath: string;
  label: string;
}

interface ExplorerState {
  // Panel visibility (controlled by appStore.showFileExplorer)
  tabs: ExplorerTab[];
  activeTabId: string;

  // Directory contents cache
  dirContents: Record<string, FileInfo[]>;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;

  // Selection for drag
  selectedPaths: string[];

  // Actions
  addTab: (rootPath: string, label: string) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setDirContents: (path: string, contents: FileInfo[]) => void;
  toggleExpanded: (path: string) => void;
  setExpanded: (path: string, expanded: boolean) => void;
  setLoading: (path: string, loading: boolean) => void;
  toggleSelection: (path: string) => void;
  clearSelection: () => void;
  reset: () => void;
}

let tabCounter = 0;

export const useExplorerStore = create<ExplorerState>((set) => ({
  tabs: [],
  activeTabId: '',
  dirContents: {},
  expandedPaths: new Set<string>(),
  loadingPaths: new Set<string>(),
  selectedPaths: [],

  addTab: (rootPath, label) => {
    const id = `tab-${++tabCounter}`;
    set((state) => ({
      tabs: [...state.tabs, { id, rootPath, label }],
      activeTabId: id,
    }));
  },

  closeTab: (id) => {
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== id);
      const newActiveId = state.activeTabId === id
        ? (newTabs[newTabs.length - 1]?.id ?? '')
        : state.activeTabId;
      return { tabs: newTabs, activeTabId: newActiveId };
    });
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  setDirContents: (path, contents) =>
    set((state) => ({
      dirContents: { ...state.dirContents, [path]: contents },
    })),

  toggleExpanded: (path) =>
    set((state) => {
      const next = new Set(state.expandedPaths);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return { expandedPaths: next };
    }),

  setExpanded: (path, expanded) =>
    set((state) => {
      const next = new Set(state.expandedPaths);
      if (expanded) next.add(path);
      else next.delete(path);
      return { expandedPaths: next };
    }),

  setLoading: (path, loading) =>
    set((state) => {
      const next = new Set(state.loadingPaths);
      if (loading) next.add(path);
      else next.delete(path);
      return { loadingPaths: next };
    }),

  toggleSelection: (path) =>
    set((state) => {
      const idx = state.selectedPaths.indexOf(path);
      if (idx >= 0) {
        return { selectedPaths: state.selectedPaths.filter((p) => p !== path) };
      }
      return { selectedPaths: [...state.selectedPaths, path] };
    }),

  clearSelection: () => set({ selectedPaths: [] }),

  reset: () => set({
    tabs: [],
    activeTabId: '',
    dirContents: {},
    expandedPaths: new Set(),
    loadingPaths: new Set(),
    selectedPaths: [],
  }),
}));

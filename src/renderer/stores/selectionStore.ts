import { create } from 'zustand';
import { useSessionUIStore } from './sessionUIStore';

const PINNED_STORAGE_KEY = 'pinned-sessions';

function parsePinnedIds(raw: string): Set<string> {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
    ? new Set<string>(parsed)
    : new Set<string>();
}

function loadPinnedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    if (raw) {
      return parsePinnedIds(raw);
    }
  } catch {
    // ignore
  }
  return new Set<string>();
}

function savePinnedIds(ids: Set<string>): void {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
}

interface SelectionState {
  pinnedSessionIds: Set<string>;
  multiSelectMode: boolean;
  selectedSessionIds: Set<string>;
}

interface SelectionActions {
  togglePin: (id: string) => void;
  isPinned: (id: string) => boolean;
  toggleMultiSelect: () => void;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  batchDelete: () => void;
}

type SelectionStore = SelectionState & SelectionActions;

export const useSelectionStore = create<SelectionStore>()((set, get) => ({
  pinnedSessionIds: loadPinnedIds(),
  multiSelectMode: false,
  selectedSessionIds: new Set<string>(),

  togglePin: (id: string) => {
    const { pinnedSessionIds } = get();
    const newPinned = new Set(pinnedSessionIds);
    if (newPinned.has(id)) {
      newPinned.delete(id);
    } else {
      newPinned.add(id);
    }
    savePinnedIds(newPinned);
    set({ pinnedSessionIds: newPinned });
  },

  isPinned: (id: string) => {
    return get().pinnedSessionIds.has(id);
  },

  toggleMultiSelect: () => {
    const { multiSelectMode } = get();
    if (multiSelectMode) {
      set({ multiSelectMode: false, selectedSessionIds: new Set<string>() });
    } else {
      set({ multiSelectMode: true });
    }
  },

  toggleSelection: (id: string) => {
    const { selectedSessionIds } = get();
    const newSelected = new Set(selectedSessionIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    set({ selectedSessionIds: newSelected });
  },

  clearSelection: () => {
    set({ selectedSessionIds: new Set<string>() });
  },

  batchDelete: () => {
    const { selectedSessionIds } = get();
    if (selectedSessionIds.size === 0) return;
    useSessionUIStore.getState().softDelete([...selectedSessionIds]);
    set({ multiSelectMode: false, selectedSessionIds: new Set<string>() });
  },
}));

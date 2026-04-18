import { create } from 'zustand';
import { IPC_DOMAINS } from '@shared/ipc';
import { useSessionStore, type SessionFilter } from './sessionStore';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';

const logger = createLogger('SessionUIStore');

async function deleteSession(id: string): Promise<void> {
  const response = await window.domainAPI?.invoke(IPC_DOMAINS.SESSION, 'delete', { sessionId: id });
  if (!response?.success) {
    throw new Error(response?.error?.message || 'Failed to delete session');
  }
}

export type { SessionFilter };

export type SessionStatusFilter = 'all' | 'background';

export interface PendingDelete {
  ids: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

interface SessionUIState {
  pendingDelete: PendingDelete | null;
  filter: SessionFilter;
  searchQuery: string;
  sessionStatusFilter: SessionStatusFilter;
  inputHistory: string[];
  inputHistoryIndex: number;
  inputHistoryDraft: string;
}

interface SessionUIActions {
  setFilter: (filter: SessionFilter) => void;
  setSearchQuery: (query: string) => void;
  setSessionStatusFilter: (filter: SessionStatusFilter) => void;
  softDelete: (ids: string[]) => void;
  undoDelete: () => void;
  confirmDelete: () => Promise<void>;
  addToInputHistory: (input: string) => void;
  getPreviousInput: (currentInput: string) => string | null;
  getNextInput: () => string | null;
  resetInputHistoryIndex: () => void;
}

type SessionUIStore = SessionUIState & SessionUIActions;

export const useSessionUIStore = create<SessionUIStore>()((set, get) => ({
  pendingDelete: null,
  filter: 'active' as SessionFilter,
  searchQuery: '',
  sessionStatusFilter: 'all',
  inputHistory: [],
  inputHistoryIndex: -1,
  inputHistoryDraft: '',

  setFilter: (filter: SessionFilter) => {
    set({ filter });
    useSessionStore.getState().loadSessions();
  },

  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  setSessionStatusFilter: (sessionStatusFilter: SessionStatusFilter) => {
    set({ sessionStatusFilter });
  },

  softDelete: (ids: string[]) => {
    const sessionStore = useSessionStore.getState();
    const { sessions } = sessionStore;
    const { pendingDelete } = get();

    if (pendingDelete) {
      if (pendingDelete.timer) clearTimeout(pendingDelete.timer);
      // Snapshot IDs and clear pendingDelete first to prevent double deletion
      const prevIds = [...pendingDelete.ids];
      set({ pendingDelete: null });
      (async () => {
        for (const id of prevIds) {
          try {
            await deleteSession(id);
          } catch (error) {
            logger.error('Failed to delete session in previous batch', error);
          }
        }
      })();
    }

    const idsSet = new Set(ids);
    const remainingSessions = sessions.filter((s) => !idsSet.has(s.id));

    const timer = setTimeout(() => {
      get().confirmDelete();
    }, 5000);

    useSessionStore.setState({ sessions: remainingSessions });
    set({ pendingDelete: { ids, timer } });

    const { currentSessionId } = useSessionStore.getState();
    if (currentSessionId && idsSet.has(currentSessionId)) {
      if (remainingSessions.length > 0) {
        sessionStore.switchSession(remainingSessions[0].id);
      } else {
        useSessionStore.setState({ currentSessionId: null, messages: [] });
      }
    }

    logger.info('Sessions soft deleted', { count: ids.length });
  },

  undoDelete: () => {
    const { pendingDelete } = get();
    if (!pendingDelete) return;

    if (pendingDelete.timer) clearTimeout(pendingDelete.timer);

    set({ pendingDelete: null });
    useSessionStore.getState().loadSessions();
    logger.info('Delete undone', { count: pendingDelete.ids.length });
  },

  confirmDelete: async () => {
    const { pendingDelete } = get();
    if (!pendingDelete) return;

    if (pendingDelete.timer) clearTimeout(pendingDelete.timer);

    // Snapshot and clear atomically to prevent race with concurrent softDelete
    const idsToDelete = [...pendingDelete.ids];
    set({ pendingDelete: null });

    for (const id of idsToDelete) {
      try {
        await deleteSession(id);
      } catch (error) {
        logger.error('Failed to confirm delete session', error);
      }
    }

    logger.info('Sessions permanently deleted', { count: idsToDelete.length });
  },

  addToInputHistory: (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    const { inputHistory } = get();
    if (inputHistory.length > 0 && inputHistory[0] === trimmed) {
      return;
    }

    const newHistory = [trimmed, ...inputHistory].slice(0, 100);
    set({
      inputHistory: newHistory,
      inputHistoryIndex: -1,
      inputHistoryDraft: '',
    });
  },

  getPreviousInput: (currentInput: string) => {
    const { inputHistory, inputHistoryIndex } = get();

    if (inputHistory.length === 0) return null;

    if (inputHistoryIndex === -1) {
      set({ inputHistoryDraft: currentInput });
    }

    const newIndex = Math.min(inputHistoryIndex + 1, inputHistory.length - 1);
    if (newIndex === inputHistoryIndex) return null;

    set({ inputHistoryIndex: newIndex });
    return inputHistory[newIndex];
  },

  getNextInput: () => {
    const { inputHistory, inputHistoryIndex, inputHistoryDraft } = get();

    if (inputHistoryIndex === -1) return null;

    const newIndex = inputHistoryIndex - 1;
    set({ inputHistoryIndex: newIndex });

    if (newIndex === -1) {
      return inputHistoryDraft;
    }

    return inputHistory[newIndex];
  },

  resetInputHistoryIndex: () => {
    set({
      inputHistoryIndex: -1,
      inputHistoryDraft: '',
    });
  },
}));

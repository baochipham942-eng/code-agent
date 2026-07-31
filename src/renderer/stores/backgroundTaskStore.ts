import { create } from 'zustand';
import { BackgroundTaskSchemas } from '@shared/ipc/schemas';
import type { Task, TaskNotification } from '@shared/contract/backgroundTask';
import ipcService from '../services/ipcService';
import { typedInvokeDomain } from '../services/typedInvoke';
import { createLogger } from '../utils/logger';

const logger = createLogger('BackgroundTaskStore');

interface BackgroundTaskStoreState {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;
  /** The ledger read failed. Kept separate from every task's real execution status. */
  readFailure: {
    message: string;
    failedAt: number;
  } | null;
  readRetryNonce: number;
  lastLoadedAt: number | null;
}

interface BackgroundTaskStoreActions {
  refreshTasks: () => Promise<void>;
  requestStatusReadRetry: () => void;
  drainNotifications: (sessionId: string) => Promise<TaskNotification[]>;
  setTasks: (tasks: Task[]) => void;
}

type BackgroundTaskStore = BackgroundTaskStoreState & BackgroundTaskStoreActions;

export const useBackgroundTaskStore = create<BackgroundTaskStore>()((set) => ({
  tasks: [],
  isLoading: false,
  error: null,
  readFailure: null,
  readRetryNonce: 0,
  lastLoadedAt: null,

  refreshTasks: async () => {
    if (!ipcService.isAvailable()) return;
    set({ isLoading: true, error: null });
    try {
      const response = await typedInvokeDomain(BackgroundTaskSchemas.LIST_TASKS, {
        action: 'listTasks',
      });
      if (!response.success) {
        throw new Error(response.error.message);
      }
      const tasks = response.data;
      set({
        tasks,
        isLoading: false,
        error: null,
        readFailure: null,
        lastLoadedAt: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Preserve the last known task status. A ledger read failure does not mean
      // the task failed, and callers must stop automatic waiting until an
      // explicit retry succeeds.
      set({
        isLoading: false,
        error: message,
        readFailure: {
          message,
          failedAt: Date.now(),
        },
      });
      throw error;
    }
  },

  requestStatusReadRetry: () => set((state) => ({
    readRetryNonce: state.readRetryNonce + 1,
  })),

  drainNotifications: async (sessionId) => {
    if (!ipcService.isAvailable()) return [];
    try {
      const response = await typedInvokeDomain(BackgroundTaskSchemas.DRAIN_NOTIFICATIONS, {
        action: 'drainNotifications',
        payload: { sessionId },
      });
      if (!response.success) {
        throw new Error(response.error.message);
      }
      return response.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to drain background task notifications', { error: message });
      set({ error: message });
      return [];
    }
  },

  setTasks: (tasks) => set({
    tasks,
    error: null,
    readFailure: null,
    lastLoadedAt: Date.now(),
  }),
}));

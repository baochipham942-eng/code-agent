import { create } from 'zustand';
import { IPC_DOMAINS } from '@shared/ipc';
import type { Task, TaskNotification } from '@shared/contract/backgroundTask';
import ipcService from '../services/ipcService';
import { createLogger } from '../utils/logger';

const logger = createLogger('BackgroundTaskStore');

interface BackgroundTaskStoreState {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;
  lastLoadedAt: number | null;
}

interface BackgroundTaskStoreActions {
  refreshTasks: () => Promise<void>;
  drainNotifications: (sessionId: string) => Promise<TaskNotification[]>;
  setTasks: (tasks: Task[]) => void;
}

type BackgroundTaskStore = BackgroundTaskStoreState & BackgroundTaskStoreActions;

export const useBackgroundTaskStore = create<BackgroundTaskStore>()((set) => ({
  tasks: [],
  isLoading: false,
  error: null,
  lastLoadedAt: null,

  refreshTasks: async () => {
    if (!ipcService.isAvailable()) return;
    set({ isLoading: true, error: null });
    try {
      const tasks = await ipcService.invokeDomain<Task[]>(
        IPC_DOMAINS.BACKGROUND_TASKS,
        'listTasks',
      );
      set({
        tasks,
        isLoading: false,
        error: null,
        lastLoadedAt: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to refresh background tasks', { error: message });
      set({ isLoading: false, error: message });
    }
  },

  drainNotifications: async (sessionId) => {
    if (!ipcService.isAvailable()) return [];
    try {
      return await ipcService.invokeDomain<TaskNotification[]>(
        IPC_DOMAINS.BACKGROUND_TASKS,
        'drainNotifications',
        { sessionId },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to drain background task notifications', { error: message });
      set({ error: message });
      return [];
    }
  },

  setTasks: (tasks) => set({
    tasks,
    lastLoadedAt: Date.now(),
  }),
}));

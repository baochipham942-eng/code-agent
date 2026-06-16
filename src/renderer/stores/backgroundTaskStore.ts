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
        lastLoadedAt: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 仅更新 UI 错误态；日志与退避交给调用方 poller（节流，避免后端不可达时刷屏）
      set({ isLoading: false, error: message });
      throw error;
    }
  },

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
    lastLoadedAt: Date.now(),
  }),
}));

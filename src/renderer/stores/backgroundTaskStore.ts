import { create } from 'zustand';
import { BackgroundTaskSchemas } from '@shared/ipc/schemas';
import { RENDERER_POLLING } from '@shared/constants';
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
  /** 连续读失败次数。到阈值前只退避重试，不置 readFailure、不停摆。 */
  consecutiveReadFailures: number;
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
  consecutiveReadFailures: 0,

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
        // 恢复即自动清黄条，不需要用户手动点重试。
        consecutiveReadFailures: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Preserve the last known task status. A ledger read failure does not mean
      // the task failed, and callers must stop automatic waiting until an
      // explicit retry succeeds.
      // 0 rows ≠ failure（2026-08-04 C.11）：手头没有任何任务时读失败只是
      // 「没有任务」，不置用户可见的 readFailure；确有任务、状态无法确认时才置位。
      // 一次异常 ≠ 读不出来（2026-08-05 C3）：达到阈值前只累计并退避重试，
      // 置位 readFailure 才会让 useBackgroundTaskSync 冻结投影停摆。
      set((state) => {
        const consecutiveReadFailures = state.consecutiveReadFailures + 1;
        const exhausted = consecutiveReadFailures >= RENDERER_POLLING.BACKGROUND_TASK_READ_FAILURE_THRESHOLD;
        return {
          isLoading: false,
          error: message,
          consecutiveReadFailures,
          readFailure: exhausted && state.tasks.length > 0
            ? { message, failedAt: Date.now() }
            : null,
        };
      });
      throw error;
    }
  },

  requestStatusReadRetry: () => set((state) => ({
    readRetryNonce: state.readRetryNonce + 1,
    // 手动重试 = 重新给满容忍次数，否则重试一失败就又立刻停摆。
    consecutiveReadFailures: 0,
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
    consecutiveReadFailures: 0,
  }),
}));

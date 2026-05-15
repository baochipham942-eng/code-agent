import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { ListTasksFilter } from '../../shared/contract/backgroundTask';
import { createLogger } from '../services/infra/logger';
import { getBackgroundTaskLedger } from '../tasks/backgroundTaskLedger';
import {
  installBackgroundTaskEventAdapters,
  syncBackgroundTaskSnapshotsToLedger,
} from '../tasks/backgroundTaskSnapshotAdapters';

const logger = createLogger('BackgroundTaskLedgerIPC');

function syncSnapshots(): void {
  syncBackgroundTaskSnapshotsToLedger(getBackgroundTaskLedger());
}

export function registerBackgroundTaskLedgerHandlers(ipcMain: IpcMain): void {
  installBackgroundTaskEventAdapters(getBackgroundTaskLedger());

  ipcMain.handle(IPC_DOMAINS.BACKGROUND_TASKS, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;
    const ledger = getBackgroundTaskLedger();

    try {
      switch (action) {
        case 'listTasks': {
          syncSnapshots();
          const filter = (payload || {}) as ListTasksFilter;
          return { success: true, data: ledger.listTasks(filter) } satisfies IPCResponse;
        }

        case 'getTask': {
          syncSnapshots();
          const taskId = (payload as { taskId?: string } | null)?.taskId;
          if (!taskId) {
            return { success: false, error: { code: 'INVALID_INPUT', message: 'taskId is required' } } satisfies IPCResponse;
          }
          return { success: true, data: ledger.getTask(taskId) } satisfies IPCResponse;
        }

        case 'drainNotifications': {
          const sessionId = (payload as { sessionId?: string } | null)?.sessionId;
          if (!sessionId) {
            return { success: false, error: { code: 'INVALID_INPUT', message: 'sessionId is required' } } satisfies IPCResponse;
          }
          return { success: true, data: ledger.drainNotifications(sessionId) } satisfies IPCResponse;
        }

        case 'markNotificationDelivered': {
          const notificationId = (payload as { notificationId?: string } | null)?.notificationId;
          if (!notificationId) {
            return { success: false, error: { code: 'INVALID_INPUT', message: 'notificationId is required' } } satisfies IPCResponse;
          }
          return { success: true, data: ledger.markNotificationDelivered(notificationId) } satisfies IPCResponse;
        }

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown background task action: ${action}` },
          } satisfies IPCResponse;
      }
    } catch (error) {
      logger.error('Background task ledger IPC error:', error);
      return {
        success: false,
        error: {
          code: 'BACKGROUND_TASK_LEDGER_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      } satisfies IPCResponse;
    }
  });
}

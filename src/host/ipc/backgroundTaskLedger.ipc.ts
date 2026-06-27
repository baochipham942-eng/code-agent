import type { IpcMain } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import { BackgroundTaskSchemas } from '../../shared/ipc/schemas';
import { createLogger } from '../services/infra/logger';
import { getDatabase } from '../services/core/databaseService';
import { defineHandler } from '../platform/ipcRegistry';
import { type BackgroundTaskLedger, getBackgroundTaskLedger } from '../task/backgroundTaskLedger';
import { SqliteBackgroundTaskStore } from '../task/backgroundTaskStore';
import {
  installBackgroundTaskEventAdapters,
  syncBackgroundTaskSnapshotsToLedger,
} from '../task/backgroundTaskSnapshotAdapters';

const logger = createLogger('BackgroundTaskLedgerIPC');
let attachedStoreDb: unknown = null;
let attachedStore: SqliteBackgroundTaskStore | null = null;

function getLedger(): BackgroundTaskLedger {
  const ledger = getBackgroundTaskLedger();
  const db = getDatabase().getDb();

  if (db && db !== attachedStoreDb) {
    attachedStore = new SqliteBackgroundTaskStore(db);
    attachedStoreDb = db;
  }

  if (attachedStore) {
    ledger.setStore(attachedStore);
  }

  return ledger;
}

function syncSnapshots(): void {
  syncBackgroundTaskSnapshotsToLedger(getLedger());
}

export function registerBackgroundTaskLedgerHandlers(ipcMain: IpcMain): void {
  installBackgroundTaskEventAdapters(getLedger());

  defineHandler(BackgroundTaskSchemas.REQUEST, async (_event, request) => {
    const { action, payload } = request;
    const ledger = getLedger();

    try {
      switch (action) {
        case 'listTasks': {
          syncSnapshots();
          const filter = payload || {};
          return { success: true, data: ledger.listTasks(filter) } satisfies IPCResponse;
        }

        case 'getTask': {
          syncSnapshots();
          return { success: true, data: ledger.getTask(payload.taskId) } satisfies IPCResponse;
        }

        case 'drainNotifications': {
          return { success: true, data: ledger.drainNotifications(payload.sessionId) } satisfies IPCResponse;
        }

        case 'markNotificationDelivered': {
          return { success: true, data: ledger.markNotificationDelivered(payload.notificationId) } satisfies IPCResponse;
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
  }, ipcMain);
}

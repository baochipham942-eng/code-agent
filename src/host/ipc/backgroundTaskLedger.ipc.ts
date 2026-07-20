import { open } from 'fs/promises';
import type { IpcMain } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import { BACKGROUND_TASK_LOG } from '../../shared/constants';
import { BackgroundTaskSchemas, type ResponseOf } from '../../shared/ipc/schemas';
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
type TaskLogReadResponse = ResponseOf<typeof BackgroundTaskSchemas.READ_TASK_LOG>;
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

function syncSnapshots(ledger: BackgroundTaskLedger): void {
  ledger.runQuiet(() => syncBackgroundTaskSnapshotsToLedger(ledger));
}

function taskLogError(code: string, message: string): TaskLogReadResponse {
  return { success: false, error: { code, message } };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function readTaskLog(
  ledger: BackgroundTaskLedger,
  taskId: string,
  refId: string,
): Promise<TaskLogReadResponse> {
  const task = ledger.getTask(taskId);
  if (!task) {
    return taskLogError('BACKGROUND_TASK_NOT_FOUND', `Unknown background task: ${taskId}`);
  }

  const outputRef = task.outputRefs.find((ref) => ref.id === refId);
  if (!outputRef) {
    return taskLogError('BACKGROUND_TASK_LOG_REF_NOT_FOUND', `Unknown task output ref: ${refId}`);
  }
  if (outputRef.type !== 'log') {
    return taskLogError('BACKGROUND_TASK_LOG_REF_INVALID', `Task output ref is not a log: ${refId}`);
  }
  if (!outputRef.path) {
    return taskLogError('BACKGROUND_TASK_LOG_PATH_MISSING', `Task log ref has no registered path: ${refId}`);
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(outputRef.path, 'r');
  } catch (error) {
    return taskLogError(
      isMissingFileError(error) ? 'BACKGROUND_TASK_LOG_FILE_NOT_FOUND' : 'BACKGROUND_TASK_LOG_FILE_UNREADABLE',
      isMissingFileError(error) ? 'Task log file does not exist' : 'Task log file is not readable',
    );
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return taskLogError('BACKGROUND_TASK_LOG_FILE_UNREADABLE', 'Task log path is not a readable file');
    }
    const bytesToRead = Math.min(stat.size, BACKGROUND_TASK_LOG.TAIL_MAX_BYTES);
    if (bytesToRead === 0) {
      return { success: true, data: { content: '', truncated: false, size: 0 } };
    }
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
    return {
      success: true,
      data: {
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        truncated: stat.size > BACKGROUND_TASK_LOG.TAIL_MAX_BYTES,
        size: stat.size,
      },
    };
  } catch (error) {
    return taskLogError(
      isMissingFileError(error) ? 'BACKGROUND_TASK_LOG_FILE_NOT_FOUND' : 'BACKGROUND_TASK_LOG_FILE_UNREADABLE',
      isMissingFileError(error) ? 'Task log file does not exist' : 'Task log file is not readable',
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function registerBackgroundTaskLedgerHandlers(ipcMain: IpcMain): void {
  installBackgroundTaskEventAdapters(getLedger());

  defineHandler(BackgroundTaskSchemas.REQUEST, async (_event, request) => {
    const { action, payload } = request;
    const ledger = getLedger();

    try {
      switch (action) {
        case 'listTasks': {
          syncSnapshots(ledger);
          const filter = payload || {};
          return { success: true, data: ledger.listTasks(filter) } satisfies IPCResponse;
        }

        case 'getTask': {
          syncSnapshots(ledger);
          return { success: true, data: ledger.getTask(payload.taskId) } satisfies IPCResponse;
        }

        case 'readTaskLog': {
          syncSnapshots(ledger);
          return await readTaskLog(ledger, payload.taskId, payload.refId);
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

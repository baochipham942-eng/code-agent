// ============================================================================
// Cloud IPC Handlers - cloud:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type {
  CloudTask,
  CreateCloudTaskRequest,
  CloudTaskFilter,
  TaskSyncState,
  CloudExecutionStats,
} from '../../shared/types/cloud';
import {
  getCloudTaskService,
  isCloudTaskServiceInitialized,
} from '../cloud/CloudTaskService';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleConfigRefresh(): Promise<unknown> {
  const { refreshCloudConfig } = await import('../services/cloud');
  return refreshCloudConfig();
}

async function handleConfigGetInfo(): Promise<unknown> {
  const { getCloudConfigService } = await import('../services/cloud');
  return getCloudConfigService().getInfo();
}

async function handleTaskCreate(payload: { request: CreateCloudTaskRequest }): Promise<CloudTask | null> {
  if (!isCloudTaskServiceInitialized()) {
    console.warn('[IPC] Cloud task service not initialized');
    return null;
  }
  return getCloudTaskService().createTask(payload.request);
}

async function handleTaskGet(payload: { taskId: string }): Promise<CloudTask | null> {
  if (!isCloudTaskServiceInitialized()) return null;
  return getCloudTaskService().getTask(payload.taskId);
}

async function handleTaskList(payload?: { filter?: CloudTaskFilter }): Promise<CloudTask[]> {
  if (!isCloudTaskServiceInitialized()) return [];
  return getCloudTaskService().listTasks(payload?.filter);
}

async function handleTaskStart(payload: { taskId: string }): Promise<boolean> {
  if (!isCloudTaskServiceInitialized()) return false;
  return getCloudTaskService().startTask(payload.taskId);
}

async function handleTaskPause(payload: { taskId: string }): Promise<boolean> {
  if (!isCloudTaskServiceInitialized()) return false;
  return getCloudTaskService().pauseTask(payload.taskId);
}

async function handleTaskCancel(payload: { taskId: string }): Promise<boolean> {
  if (!isCloudTaskServiceInitialized()) return false;
  return getCloudTaskService().cancelTask(payload.taskId);
}

async function handleTaskRetry(payload: { taskId: string }): Promise<boolean> {
  if (!isCloudTaskServiceInitialized()) return false;
  return getCloudTaskService().retryTask(payload.taskId);
}

async function handleTaskDelete(payload: { taskId: string }): Promise<boolean> {
  if (!isCloudTaskServiceInitialized()) return false;
  return getCloudTaskService().deleteTask(payload.taskId);
}

async function handleTaskSyncState(): Promise<TaskSyncState | null> {
  if (!isCloudTaskServiceInitialized()) return null;
  return getCloudTaskService().getSyncState();
}

async function handleTaskStats(): Promise<CloudExecutionStats | null> {
  if (!isCloudTaskServiceInitialized()) return null;
  return getCloudTaskService().getStats();
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Cloud 相关 IPC handlers
 */
export function registerCloudHandlers(ipcMain: IpcMain): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.CLOUD, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'configRefresh':
          data = await handleConfigRefresh();
          break;
        case 'configGetInfo':
          data = await handleConfigGetInfo();
          break;
        case 'taskCreate':
          data = await handleTaskCreate(payload as { request: CreateCloudTaskRequest });
          break;
        case 'taskGet':
          data = await handleTaskGet(payload as { taskId: string });
          break;
        case 'taskList':
          data = await handleTaskList(payload as { filter?: CloudTaskFilter } | undefined);
          break;
        case 'taskStart':
          data = await handleTaskStart(payload as { taskId: string });
          break;
        case 'taskPause':
          data = await handleTaskPause(payload as { taskId: string });
          break;
        case 'taskCancel':
          data = await handleTaskCancel(payload as { taskId: string });
          break;
        case 'taskRetry':
          data = await handleTaskRetry(payload as { taskId: string });
          break;
        case 'taskDelete':
          data = await handleTaskDelete(payload as { taskId: string });
          break;
        case 'taskSyncState':
          data = await handleTaskSyncState();
          break;
        case 'taskStats':
          data = await handleTaskStats();
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'configRefresh' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_CONFIG_REFRESH, async () => handleConfigRefresh());

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'configGetInfo' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_CONFIG_GET_INFO, async () => handleConfigGetInfo());

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'taskCreate' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_CREATE, async (_, request: CreateCloudTaskRequest) =>
    handleTaskCreate({ request })
  );

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'taskGet' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_GET, async (_, taskId: string) =>
    handleTaskGet({ taskId })
  );

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'taskList' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_LIST, async (_, filter?: CloudTaskFilter) =>
    handleTaskList({ filter })
  );

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'taskStart' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_START, async (_, taskId: string) =>
    handleTaskStart({ taskId })
  );

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'taskPause' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_PAUSE, async (_, taskId: string) =>
    handleTaskPause({ taskId })
  );

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'taskCancel' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_CANCEL, async (_, taskId: string) =>
    handleTaskCancel({ taskId })
  );

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'taskRetry' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_RETRY, async (_, taskId: string) =>
    handleTaskRetry({ taskId })
  );

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'taskDelete' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_DELETE, async (_, taskId: string) =>
    handleTaskDelete({ taskId })
  );

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'taskSyncState' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_SYNC_STATE, async () => handleTaskSyncState());

  /** @deprecated Use IPC_DOMAINS.CLOUD with action: 'taskStats' */
  ipcMain.handle(IPC_CHANNELS.CLOUD_TASK_STATS, async () => handleTaskStats());
}

// ============================================================================
// Cloud IPC Handlers - cloud:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { CloudTask, CreateCloudTaskRequest, CloudTaskFilter, TaskSyncState, CloudExecutionStats } from '../../shared/types/cloud';
import {
  getCloudTaskService,
  isCloudTaskServiceInitialized,
} from '../cloud/cloudTaskService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CloudIPC');

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
    logger.warn('Cloud task service not initialized');
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

}

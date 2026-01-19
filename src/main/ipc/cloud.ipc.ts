// ============================================================================
// Cloud IPC Handlers - cloud:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
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

/**
 * 注册 Cloud 相关 IPC handlers
 */
export function registerCloudHandlers(ipcMain: IpcMain): void {
  // Cloud Config handlers
  ipcMain.handle(IPC_CHANNELS.CLOUD_CONFIG_REFRESH, async () => {
    const { refreshCloudConfig } = await import('../services/cloud');
    return refreshCloudConfig();
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_CONFIG_GET_INFO, async () => {
    const { getCloudConfigService } = await import('../services/cloud');
    return getCloudConfigService().getInfo();
  });

  // Cloud Task handlers
  ipcMain.handle(
    IPC_CHANNELS.CLOUD_TASK_CREATE,
    async (_, request: CreateCloudTaskRequest): Promise<CloudTask | null> => {
      if (!isCloudTaskServiceInitialized()) {
        console.warn('[IPC] Cloud task service not initialized');
        return null;
      }
      const cloudTaskService = getCloudTaskService();
      return cloudTaskService.createTask(request);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_TASK_GET,
    async (_, taskId: string): Promise<CloudTask | null> => {
      if (!isCloudTaskServiceInitialized()) {
        return null;
      }
      const cloudTaskService = getCloudTaskService();
      return cloudTaskService.getTask(taskId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_TASK_LIST,
    async (_, filter?: CloudTaskFilter): Promise<CloudTask[]> => {
      if (!isCloudTaskServiceInitialized()) {
        return [];
      }
      const cloudTaskService = getCloudTaskService();
      return cloudTaskService.listTasks(filter);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_TASK_START,
    async (_, taskId: string): Promise<boolean> => {
      if (!isCloudTaskServiceInitialized()) {
        return false;
      }
      const cloudTaskService = getCloudTaskService();
      return cloudTaskService.startTask(taskId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_TASK_PAUSE,
    async (_, taskId: string): Promise<boolean> => {
      if (!isCloudTaskServiceInitialized()) {
        return false;
      }
      const cloudTaskService = getCloudTaskService();
      return cloudTaskService.pauseTask(taskId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_TASK_CANCEL,
    async (_, taskId: string): Promise<boolean> => {
      if (!isCloudTaskServiceInitialized()) {
        return false;
      }
      const cloudTaskService = getCloudTaskService();
      return cloudTaskService.cancelTask(taskId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_TASK_RETRY,
    async (_, taskId: string): Promise<boolean> => {
      if (!isCloudTaskServiceInitialized()) {
        return false;
      }
      const cloudTaskService = getCloudTaskService();
      return cloudTaskService.retryTask(taskId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_TASK_DELETE,
    async (_, taskId: string): Promise<boolean> => {
      if (!isCloudTaskServiceInitialized()) {
        return false;
      }
      const cloudTaskService = getCloudTaskService();
      return cloudTaskService.deleteTask(taskId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_TASK_SYNC_STATE,
    async (): Promise<TaskSyncState | null> => {
      if (!isCloudTaskServiceInitialized()) {
        return null;
      }
      const cloudTaskService = getCloudTaskService();
      return cloudTaskService.getSyncState();
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CLOUD_TASK_STATS,
    async (): Promise<CloudExecutionStats | null> => {
      if (!isCloudTaskServiceInitialized()) {
        return null;
      }
      const cloudTaskService = getCloudTaskService();
      return cloudTaskService.getStats();
    }
  );
}

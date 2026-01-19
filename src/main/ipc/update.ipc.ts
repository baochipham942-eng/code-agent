// ============================================================================
// Update IPC Handlers - update:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { app } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { UpdateInfo } from '../../shared/types';
import { getUpdateService, isUpdateServiceInitialized } from '../services/cloud/UpdateService';

/**
 * 注册 Update 相关 IPC handlers
 */
export function registerUpdateHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async (): Promise<UpdateInfo> => {
    if (!isUpdateServiceInitialized()) {
      return {
        hasUpdate: false,
        currentVersion: app.getVersion(),
      };
    }
    const updateService = getUpdateService();
    return updateService.checkForUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_INFO, async (): Promise<UpdateInfo | null> => {
    if (!isUpdateServiceInitialized()) {
      return null;
    }
    const updateService = getUpdateService();
    return updateService.getCachedUpdateInfo();
  });

  ipcMain.handle(
    IPC_CHANNELS.UPDATE_DOWNLOAD,
    async (_, downloadUrl: string): Promise<string> => {
      if (!isUpdateServiceInitialized()) {
        throw new Error('Update service not initialized');
      }
      const updateService = getUpdateService();
      return updateService.downloadUpdate(downloadUrl);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.UPDATE_OPEN_FILE,
    async (_, filePath: string): Promise<void> => {
      if (!isUpdateServiceInitialized()) {
        throw new Error('Update service not initialized');
      }
      const updateService = getUpdateService();
      await updateService.openDownloadedFile(filePath);
    }
  );

  ipcMain.handle(IPC_CHANNELS.UPDATE_OPEN_URL, async (_, url: string): Promise<void> => {
    if (!isUpdateServiceInitialized()) {
      throw new Error('Update service not initialized');
    }
    const updateService = getUpdateService();
    await updateService.openDownloadUrl(url);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_START_AUTO_CHECK, async (): Promise<void> => {
    if (!isUpdateServiceInitialized()) {
      return;
    }
    const updateService = getUpdateService();
    updateService.startAutoCheck();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_STOP_AUTO_CHECK, async (): Promise<void> => {
    if (!isUpdateServiceInitialized()) {
      return;
    }
    const updateService = getUpdateService();
    updateService.stopAutoCheck();
  });
}

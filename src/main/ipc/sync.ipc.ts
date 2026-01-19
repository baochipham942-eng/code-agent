// ============================================================================
// Sync IPC Handlers - sync:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getAuthService, getSyncService } from '../services';

/**
 * 注册 Sync 相关 IPC handlers
 */
export function registerSyncHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.SYNC_GET_STATUS, async () => {
    const syncService = getSyncService();
    return syncService.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_START, async () => {
    const syncService = getSyncService();
    await syncService.startAutoSync();
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_STOP, async () => {
    const syncService = getSyncService();
    syncService.stopAutoSync();
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_FORCE_FULL, async () => {
    const syncService = getSyncService();
    const result = await syncService.forceFullSync();
    return { success: result.success, error: result.error };
  });

  ipcMain.handle(
    IPC_CHANNELS.SYNC_RESOLVE_CONFLICT,
    async (_, conflictId: string, resolution: 'local' | 'remote' | 'merge') => {
      const syncService = getSyncService();
      await syncService.resolveConflict(conflictId, resolution);
    }
  );

  // Device handlers
  ipcMain.handle(IPC_CHANNELS.DEVICE_REGISTER, async () => {
    const authService = getAuthService();
    const syncService = getSyncService();
    const user = authService.getCurrentUser();
    if (!user) {
      throw new Error('Not authenticated');
    }
    return syncService.registerDevice(user.id);
  });

  ipcMain.handle(IPC_CHANNELS.DEVICE_LIST, async () => {
    const syncService = getSyncService();
    return syncService.listDevices();
  });

  ipcMain.handle(IPC_CHANNELS.DEVICE_REMOVE, async (_, deviceId: string) => {
    const syncService = getSyncService();
    await syncService.removeDevice(deviceId);
  });
}

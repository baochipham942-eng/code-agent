// ============================================================================
// Sync IPC Handlers - sync:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { SyncStatus, DeviceInfo } from '../../shared/types';
import { getAuthService, getSyncService } from '../services';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleGetStatus(): Promise<SyncStatus> {
  return getSyncService().getStatus();
}

async function handleStart(): Promise<void> {
  await getSyncService().startAutoSync();
}

async function handleStop(): Promise<void> {
  getSyncService().stopAutoSync();
}

async function handleForceFull(): Promise<{ success: boolean; error?: string }> {
  const result = await getSyncService().forceFullSync();
  return { success: result.success, error: result.error };
}

async function handleResolveConflict(payload: { conflictId: string; resolution: 'local' | 'remote' | 'merge' }): Promise<void> {
  await getSyncService().resolveConflict(payload.conflictId, payload.resolution);
}

async function handleDeviceRegister(): Promise<DeviceInfo | null> {
  const user = getAuthService().getCurrentUser();
  if (!user) throw new Error('Not authenticated');
  return getSyncService().registerDevice(user.id);
}

async function handleDeviceList(): Promise<DeviceInfo[]> {
  return getSyncService().listDevices();
}

async function handleDeviceRemove(payload: { deviceId: string }): Promise<void> {
  await getSyncService().removeDevice(payload.deviceId);
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Sync 相关 IPC handlers
 */
export function registerSyncHandlers(ipcMain: IpcMain): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.SYNC, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'getStatus':
          data = await handleGetStatus();
          break;
        case 'start':
          await handleStart();
          data = null;
          break;
        case 'stop':
          await handleStop();
          data = null;
          break;
        case 'forceFull':
          data = await handleForceFull();
          break;
        case 'resolveConflict':
          await handleResolveConflict(payload as { conflictId: string; resolution: 'local' | 'remote' | 'merge' });
          data = null;
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Device Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.DEVICE, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'register':
          data = await handleDeviceRegister();
          break;
        case 'list':
          data = await handleDeviceList();
          break;
        case 'remove':
          await handleDeviceRemove(payload as { deviceId: string });
          data = null;
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

  /** @deprecated Use IPC_DOMAINS.SYNC with action: 'getStatus' */
  ipcMain.handle(IPC_CHANNELS.SYNC_GET_STATUS, async () => handleGetStatus());

  /** @deprecated Use IPC_DOMAINS.SYNC with action: 'start' */
  ipcMain.handle(IPC_CHANNELS.SYNC_START, async () => handleStart());

  /** @deprecated Use IPC_DOMAINS.SYNC with action: 'stop' */
  ipcMain.handle(IPC_CHANNELS.SYNC_STOP, async () => handleStop());

  /** @deprecated Use IPC_DOMAINS.SYNC with action: 'forceFull' */
  ipcMain.handle(IPC_CHANNELS.SYNC_FORCE_FULL, async () => handleForceFull());

  /** @deprecated Use IPC_DOMAINS.SYNC with action: 'resolveConflict' */
  ipcMain.handle(IPC_CHANNELS.SYNC_RESOLVE_CONFLICT, async (_, conflictId: string, resolution: 'local' | 'remote' | 'merge') =>
    handleResolveConflict({ conflictId, resolution })
  );

  /** @deprecated Use IPC_DOMAINS.DEVICE with action: 'register' */
  ipcMain.handle(IPC_CHANNELS.DEVICE_REGISTER, async () => handleDeviceRegister());

  /** @deprecated Use IPC_DOMAINS.DEVICE with action: 'list' */
  ipcMain.handle(IPC_CHANNELS.DEVICE_LIST, async () => handleDeviceList());

  /** @deprecated Use IPC_DOMAINS.DEVICE with action: 'remove' */
  ipcMain.handle(IPC_CHANNELS.DEVICE_REMOVE, async (_, deviceId: string) => handleDeviceRemove({ deviceId }));
}

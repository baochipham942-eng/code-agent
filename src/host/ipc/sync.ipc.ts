// ============================================================================
// Sync IPC Handlers - sync:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { SyncSchemas, type SyncDomainRequest } from '../../shared/ipc/schemas/sync';
import { DeviceSchemas, type DeviceDomainRequest } from '../../shared/ipc/schemas/device';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type { SyncStatus, DeviceInfo } from '../../shared/contract';
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
 * sync / device 两域单源路由表（RQ-183 续作·SYNC+DEVICE 刀）：原两个 domain switch 逐 case 平移（handler
 * 返回 data，装配器包 { success: true, data }；原 `data = null` 的 case 显式返回 null）；未知 action →
 * INVALID_ACTION `Unknown action: <action>`、抛错 → INTERNAL_ERROR（Error 取 message、非 Error 取 String(error)），均为装配器缺省。
 */
const syncRoutes = defineDomainRoutes<SyncDomainRequest, void>(SyncSchemas.REQUEST, {
  getStatus: () => handleGetStatus(),
  start: async () => {
    await handleStart();
    return null;
  },
  stop: async () => {
    await handleStop();
    return null;
  },
  forceFull: () => handleForceFull(),
  resolveConflict: async (_ctx, payload) => {
    await handleResolveConflict(payload as { conflictId: string; resolution: 'local' | 'remote' | 'merge' });
    return null;
  },
});

const deviceRoutes = defineDomainRoutes<DeviceDomainRequest, void>(DeviceSchemas.REQUEST, {
  register: () => handleDeviceRegister(),
  list: () => handleDeviceList(),
  remove: async (_ctx, payload) => {
    await handleDeviceRemove(payload as { deviceId: string });
    return null;
  },
});

/**
 * 注册 Sync 相关 IPC handlers
 */
export function registerSyncHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, syncRoutes, undefined);
  installDomainRoutes(ipcMain, deviceRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例；同文件两域两张表）
registerSyncHandlers.routes = syncRoutes;
registerSyncHandlers.deviceRoutes = deviceRoutes;

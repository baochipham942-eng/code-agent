// ============================================================================
// Update IPC Handlers - update:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { app } from '../platform';
import { UpdateSchemas, type UpdateDomainRequest } from '../../shared/ipc/schemas/update';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type {
  PrepareRuntimeAssetsResult,
  RendererBundleStatus,
  RuntimeAssetsStatus,
  UpdateInfo,
} from '../../shared/contract';
import { getUpdateService, isUpdateServiceInitialized } from '../services/cloud/updateService';
import { getRuntimeAssetsStatus } from '../runtime/runtimeAssetStatus';
import { createLogger } from '../services/infra/logger';
import { readRendererBundleStatus } from '../services/renderer/rendererBundleCache';

const logger = createLogger('UpdateIPC');

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleCheck(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion();
  if (!isUpdateServiceInitialized()) {
    return { hasUpdate: false, currentVersion };
  }
  try {
    return await getUpdateService().checkForUpdates();
  } catch (error) {
    logger.warn('Update check failed; using local version fallback', {
      error: error instanceof Error ? error.message : String(error),
      currentVersion,
    });
    return { hasUpdate: false, currentVersion };
  }
}

async function handleGetInfo(): Promise<UpdateInfo | null> {
  if (!isUpdateServiceInitialized()) return null;
  return getUpdateService().getCachedUpdateInfo();
}

async function handleDownload(payload: { downloadUrl: string }): Promise<string> {
  if (!isUpdateServiceInitialized()) throw new Error('Update service not initialized');
  return getUpdateService().downloadUpdate(payload.downloadUrl);
}

async function handleOpenFile(payload: { filePath: string }): Promise<void> {
  if (!isUpdateServiceInitialized()) throw new Error('Update service not initialized');
  await getUpdateService().openDownloadedFile(payload.filePath);
}

async function handleOpenUrl(payload: { url: string }): Promise<void> {
  if (!isUpdateServiceInitialized()) throw new Error('Update service not initialized');
  await getUpdateService().openDownloadUrl(payload.url);
}

async function handleStartAutoCheck(): Promise<void> {
  if (isUpdateServiceInitialized()) getUpdateService().startAutoCheck();
}

async function handleStopAutoCheck(): Promise<void> {
  if (isUpdateServiceInitialized()) getUpdateService().stopAutoCheck();
}

async function handleRuntimeAssetsStatus(): Promise<RuntimeAssetsStatus> {
  const status = await getRuntimeAssetsStatus({ shellVersion: app.getVersion() });
  return {
    ...status,
    preparation: isUpdateServiceInitialized()
      ? getUpdateService().getRuntimeAssetPreparationStatus()
      : null,
  };
}

async function handleRendererBundleStatus(): Promise<RendererBundleStatus> {
  return readRendererBundleStatus(app.getPath('userData'));
}

async function handlePrepareRuntimeAssets(payload?: { assetId?: string }): Promise<PrepareRuntimeAssetsResult> {
  if (!isUpdateServiceInitialized()) throw new Error('Update service not initialized');
  return payload?.assetId
    ? getUpdateService().prepareRuntimeAsset(payload.assetId)
    : getUpdateService().prepareRuntimeAssets();
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * update 域单源路由表（RQ-183 续作·UPDATE 刀）：原 domain switch 10 个 `…; data = X; break;` case 平移为默认模式 handler（data= 前的
 * 语句原样保留，data= 改 return，装配器包 { success: true, data }）。未知 action 与抛错恰为装配器缺省（INVALID_ACTION
 * `Unknown action: <action>` / INTERNAL_ERROR + Error.message / String(error)，与原文逐字一致），零配置。
 * 请求体为 null / 非对象时原实现在 try 外解构抛错（IPC reject），现返回 INVALID_ACTION。
 */
const updateRoutes = defineDomainRoutes<UpdateDomainRequest, void>(UpdateSchemas.REQUEST, {
  check: async (_ctx, _payload) => {
    return await handleCheck();
  },
  getInfo: async (_ctx, _payload) => {
    return await handleGetInfo();
  },
  download: async (_ctx, payload) => {
    return await handleDownload(payload as { downloadUrl: string });
  },
  openFile: async (_ctx, payload) => {
    await handleOpenFile(payload as { filePath: string });
    return null;
  },
  openUrl: async (_ctx, payload) => {
    await handleOpenUrl(payload as { url: string });
    return null;
  },
  startAutoCheck: async (_ctx, _payload) => {
    await handleStartAutoCheck();
    return null;
  },
  stopAutoCheck: async (_ctx, _payload) => {
    await handleStopAutoCheck();
    return null;
  },
  runtimeAssetsStatus: async (_ctx, _payload) => {
    return await handleRuntimeAssetsStatus();
  },
  rendererBundleStatus: async (_ctx, _payload) => {
    return await handleRendererBundleStatus();
  },
  prepareRuntimeAssets: async (_ctx, payload) => {
    return await handlePrepareRuntimeAssets(payload as { assetId?: string } | undefined);
  },
});

/**
 * 注册 Update 相关 IPC handlers
 */
export function registerUpdateHandlers(ipcMain: IpcMain): void {
  // ========== New Domain Handler (TASK-04) ==========
  installDomainRoutes(ipcMain, updateRoutes, undefined);

  // ========== Legacy Handlers (Deprecated) ==========

}

// 表挂装配函数对象上供 parity 门枚举（同 registerMcpHandlers.routes 先例）
registerUpdateHandlers.routes = updateRoutes;

// ============================================================================
// Update IPC Handlers - update:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import { app } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { PrepareRuntimeAssetsResult, RuntimeAssetsStatus, UpdateInfo } from '../../shared/contract';
import { getUpdateService, isUpdateServiceInitialized } from '../services/cloud/updateService';
import { getRuntimeAssetsStatus } from '../runtime/runtimeAssetStatus';
import { createLogger } from '../services/infra/logger';

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
  return getRuntimeAssetsStatus();
}

async function handlePrepareRuntimeAssets(): Promise<PrepareRuntimeAssetsResult> {
  if (!isUpdateServiceInitialized()) throw new Error('Update service not initialized');
  return getUpdateService().prepareRuntimeAssets();
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Update 相关 IPC handlers
 */
export function registerUpdateHandlers(ipcMain: IpcMain): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.UPDATE, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'check':
          data = await handleCheck();
          break;
        case 'getInfo':
          data = await handleGetInfo();
          break;
        case 'download':
          data = await handleDownload(payload as { downloadUrl: string });
          break;
        case 'openFile':
          await handleOpenFile(payload as { filePath: string });
          data = null;
          break;
        case 'openUrl':
          await handleOpenUrl(payload as { url: string });
          data = null;
          break;
        case 'startAutoCheck':
          await handleStartAutoCheck();
          data = null;
          break;
        case 'stopAutoCheck':
          await handleStopAutoCheck();
          data = null;
          break;
        case 'runtimeAssetsStatus':
          data = await handleRuntimeAssetsStatus();
          break;
        case 'prepareRuntimeAssets':
          data = await handlePrepareRuntimeAssets();
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

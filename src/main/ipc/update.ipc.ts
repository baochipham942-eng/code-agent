// ============================================================================
// Update IPC Handlers - update:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { app } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { UpdateInfo } from '../../shared/types';
import { getUpdateService, isUpdateServiceInitialized } from '../services/cloud/updateService';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleCheck(): Promise<UpdateInfo> {
  if (!isUpdateServiceInitialized()) {
    return { hasUpdate: false, currentVersion: app.getVersion() };
  }
  return getUpdateService().checkForUpdates();
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
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
      }

      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

  /** @deprecated Use IPC_DOMAINS.UPDATE with action: 'check' */
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => handleCheck());

  /** @deprecated Use IPC_DOMAINS.UPDATE with action: 'getInfo' */
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_INFO, async () => handleGetInfo());

  /** @deprecated Use IPC_DOMAINS.UPDATE with action: 'download' */
  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async (_, downloadUrl: string) =>
    handleDownload({ downloadUrl })
  );

  /** @deprecated Use IPC_DOMAINS.UPDATE with action: 'openFile' */
  ipcMain.handle(IPC_CHANNELS.UPDATE_OPEN_FILE, async (_, filePath: string) =>
    handleOpenFile({ filePath })
  );

  /** @deprecated Use IPC_DOMAINS.UPDATE with action: 'openUrl' */
  ipcMain.handle(IPC_CHANNELS.UPDATE_OPEN_URL, async (_, url: string) => handleOpenUrl({ url }));

  /** @deprecated Use IPC_DOMAINS.UPDATE with action: 'startAutoCheck' */
  ipcMain.handle(IPC_CHANNELS.UPDATE_START_AUTO_CHECK, async () => handleStartAutoCheck());

  /** @deprecated Use IPC_DOMAINS.UPDATE with action: 'stopAutoCheck' */
  ipcMain.handle(IPC_CHANNELS.UPDATE_STOP_AUTO_CHECK, async () => handleStopAutoCheck());
}

// ============================================================================
// Workspace IPC Handlers - workspace:* 通道
// ============================================================================

import type { IpcMain, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';

// Legacy channel constants (post-IPC_CHANNELS deprecation)
const LEGACY_CHANNELS = {
  WORKSPACE_SELECT_DIRECTORY: 'workspace:select-directory',
  WORKSPACE_GET_CURRENT: 'workspace:get-current',
  WORKSPACE_LIST_FILES: 'workspace:list-files',
  WORKSPACE_READ_FILE: 'workspace:read-file',
  SHELL_OPEN_PATH: 'shell:open-path',
} as const;
import type { FileInfo } from '../../shared/types';
import type { AgentApplicationService } from '../../shared/types/appService';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleSelectDirectory(
  getMainWindow: () => BrowserWindow | null,
  getAppService: () => AgentApplicationService | null
): Promise<string | null> {
  const mainWindow = getMainWindow();
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Working Directory',
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const selectedPath = result.filePaths[0];
  const appService = getAppService();
  if (appService) appService.setWorkingDirectory(selectedPath);

  return selectedPath;
}

async function handleGetCurrent(getAppService: () => AgentApplicationService | null): Promise<string | null> {
  return getAppService()?.getWorkingDirectory() ?? null;
}

async function handleListFiles(payload: { dirPath: string }): Promise<FileInfo[]> {
  const fs = await import('fs/promises');
  const pathModule = await import('path');

  try {
    const entries = await fs.readdir(payload.dirPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      path: pathModule.join(payload.dirPath, entry.name),
      isDirectory: entry.isDirectory(),
    }));
  } catch {
    return [];
  }
}

async function handleReadFile(payload: { filePath: string }): Promise<string> {
  const fs = await import('fs/promises');
  return fs.readFile(payload.filePath, 'utf-8');
}

async function handleOpenPath(
  payload: { filePath: string },
  getAppService: () => AgentApplicationService | null
): Promise<string> {
  const { shell } = await import('electron');
  const pathModule = await import('path');

  let resolvedPath = payload.filePath;

  // If path is relative, resolve it against working directory
  if (!pathModule.isAbsolute(resolvedPath)) {
    const workingDir = getAppService()?.getWorkingDirectory();
    if (workingDir) {
      resolvedPath = pathModule.join(workingDir, resolvedPath);
    }
  }

  return shell.openPath(resolvedPath);
}

async function handleShowItemInFolder(
  payload: { filePath: string },
  getAppService: () => AgentApplicationService | null
): Promise<void> {
  const { shell } = await import('electron');
  const pathModule = await import('path');

  let resolvedPath = payload.filePath;

  // If path is relative, resolve it against working directory
  if (!pathModule.isAbsolute(resolvedPath)) {
    const workingDir = getAppService()?.getWorkingDirectory();
    if (workingDir) {
      resolvedPath = pathModule.join(workingDir, resolvedPath);
    }
  }

  shell.showItemInFolder(resolvedPath);
}

async function handleDownloadFile(
  payload: { url: string; filename?: string }
): Promise<{ filePath: string }> {
  const { app } = await import('electron');
  const fs = await import('fs/promises');
  const pathModule = await import('path');

  // 下载到用户下载目录
  const downloadsDir = app.getPath('downloads');
  const filename = payload.filename || `download_${Date.now()}`;
  const filePath = pathModule.join(downloadsDir, filename);

  // 下载文件
  const response = await fetch(payload.url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await fs.writeFile(filePath, Buffer.from(buffer));

  return { filePath };
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Workspace 相关 IPC handlers
 */
export function registerWorkspaceHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null,
  getAppService: () => AgentApplicationService | null
): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.WORKSPACE, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'selectDirectory':
          data = await handleSelectDirectory(getMainWindow, getAppService);
          break;
        case 'getCurrent':
          data = await handleGetCurrent(getAppService);
          break;
        case 'listFiles':
          data = await handleListFiles(payload as { dirPath: string });
          break;
        case 'readFile':
          data = await handleReadFile(payload as { filePath: string });
          break;
        case 'openPath':
          data = await handleOpenPath(payload as { filePath: string }, getAppService);
          break;
        case 'showItemInFolder':
          data = await handleShowItemInFolder(payload as { filePath: string }, getAppService);
          break;
        case 'downloadFile':
          data = await handleDownloadFile(payload as { url: string; filename?: string });
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

  /** @deprecated Use IPC_DOMAINS.WORKSPACE with action: 'selectDirectory' */
  ipcMain.handle(LEGACY_CHANNELS.WORKSPACE_SELECT_DIRECTORY, async () =>
    handleSelectDirectory(getMainWindow, getAppService)
  );

  /** @deprecated Use IPC_DOMAINS.WORKSPACE with action: 'getCurrent' */
  ipcMain.handle(LEGACY_CHANNELS.WORKSPACE_GET_CURRENT, async () => handleGetCurrent(getAppService));

  /** @deprecated Use IPC_DOMAINS.WORKSPACE with action: 'listFiles' */
  ipcMain.handle(LEGACY_CHANNELS.WORKSPACE_LIST_FILES, async (_, dirPath: string) =>
    handleListFiles({ dirPath })
  );

  /** @deprecated Use IPC_DOMAINS.WORKSPACE with action: 'readFile' */
  ipcMain.handle(LEGACY_CHANNELS.WORKSPACE_READ_FILE, async (_, filePath: string) =>
    handleReadFile({ filePath })
  );

  /** @deprecated Use IPC_DOMAINS.WORKSPACE with action: 'openPath' */
  ipcMain.handle(LEGACY_CHANNELS.SHELL_OPEN_PATH, async (_, filePath: string) =>
    handleOpenPath({ filePath }, getAppService)
  );
}

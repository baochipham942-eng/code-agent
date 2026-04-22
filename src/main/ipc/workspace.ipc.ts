// ============================================================================
// Workspace IPC Handlers - workspace:* 通道
// ============================================================================

import type { IpcMain, BrowserWindow } from '../platform';
import { dialog } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { FileInfo } from '../../shared/contract';
import type { AgentApplicationService } from '../../shared/contract/appService';

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

async function handleSetCurrent(
  payload: { dir: string | null | undefined },
  getAppService: () => AgentApplicationService | null,
): Promise<string | null> {
  const nextDir = payload.dir?.trim();
  if (!nextDir) {
    return null;
  }

  const appService = getAppService();
  if (appService) {
    appService.setWorkingDirectory(nextDir);
  }

  return nextDir;
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

export async function handleCreateFile(
  payload: { filePath: string; content?: string }
): Promise<FileInfo> {
  const fs = await import('fs/promises');
  const pathModule = await import('path');

  // 'wx' flag: fail if path exists. Prevents accidental overwrite.
  await fs.writeFile(payload.filePath, payload.content ?? '', { flag: 'wx' });
  const stat = await fs.stat(payload.filePath);
  return {
    name: pathModule.basename(payload.filePath),
    path: payload.filePath,
    isDirectory: false,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
  };
}

export async function handleCreateFolder(payload: { dirPath: string }): Promise<FileInfo> {
  const fs = await import('fs/promises');
  const pathModule = await import('path');

  // Non-recursive: fail if exists. User clicked "New Folder", a merge would surprise them.
  await fs.mkdir(payload.dirPath);
  const stat = await fs.stat(payload.dirPath);
  return {
    name: pathModule.basename(payload.dirPath),
    path: payload.dirPath,
    isDirectory: true,
    modifiedAt: stat.mtimeMs,
  };
}

async function handleOpenPath(
  payload: { filePath: string },
  getAppService: () => AgentApplicationService | null
): Promise<string> {
  const { shell } = await import('../platform');
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
  const { shell } = await import('../platform');
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
  const { app } = await import('../platform');
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
        case 'setCurrent':
          data = await handleSetCurrent(payload as { dir: string | null | undefined }, getAppService);
          break;
        case 'listFiles':
          data = await handleListFiles(payload as { dirPath: string });
          break;
        case 'readFile':
          data = await handleReadFile(payload as { filePath: string });
          break;
        case 'createFile':
          data = await handleCreateFile(payload as { filePath: string; content?: string });
          break;
        case 'createFolder':
          data = await handleCreateFolder(payload as { dirPath: string });
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

}

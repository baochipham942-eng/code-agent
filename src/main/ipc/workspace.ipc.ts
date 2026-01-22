// ============================================================================
// Workspace IPC Handlers - workspace:* 通道
// ============================================================================

import type { IpcMain, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { FileInfo } from '../../shared/types';
import type { AgentOrchestrator } from '../agent/agentOrchestrator';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

async function handleSelectDirectory(
  getMainWindow: () => BrowserWindow | null,
  getOrchestrator: () => AgentOrchestrator | null
): Promise<string | null> {
  const mainWindow = getMainWindow();
  if (!mainWindow) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Working Directory',
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const selectedPath = result.filePaths[0];
  const orchestrator = getOrchestrator();
  if (orchestrator) orchestrator.setWorkingDirectory(selectedPath);

  return selectedPath;
}

async function handleGetCurrent(getOrchestrator: () => AgentOrchestrator | null): Promise<string | null> {
  return getOrchestrator()?.getWorkingDirectory() ?? null;
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

async function handleOpenPath(payload: { filePath: string }): Promise<string> {
  const { shell } = await import('electron');
  return shell.openPath(payload.filePath);
}

async function handleShowItemInFolder(payload: { filePath: string }): Promise<void> {
  const { shell } = await import('electron');
  shell.showItemInFolder(payload.filePath);
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
  getOrchestrator: () => AgentOrchestrator | null
): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.WORKSPACE, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      let data: unknown;

      switch (action) {
        case 'selectDirectory':
          data = await handleSelectDirectory(getMainWindow, getOrchestrator);
          break;
        case 'getCurrent':
          data = await handleGetCurrent(getOrchestrator);
          break;
        case 'listFiles':
          data = await handleListFiles(payload as { dirPath: string });
          break;
        case 'readFile':
          data = await handleReadFile(payload as { filePath: string });
          break;
        case 'openPath':
          data = await handleOpenPath(payload as { filePath: string });
          break;
        case 'showItemInFolder':
          data = await handleShowItemInFolder(payload as { filePath: string });
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
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SELECT_DIRECTORY, async () =>
    handleSelectDirectory(getMainWindow, getOrchestrator)
  );

  /** @deprecated Use IPC_DOMAINS.WORKSPACE with action: 'getCurrent' */
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_CURRENT, async () => handleGetCurrent(getOrchestrator));

  /** @deprecated Use IPC_DOMAINS.WORKSPACE with action: 'listFiles' */
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_FILES, async (_, dirPath: string) =>
    handleListFiles({ dirPath })
  );

  /** @deprecated Use IPC_DOMAINS.WORKSPACE with action: 'readFile' */
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_READ_FILE, async (_, filePath: string) =>
    handleReadFile({ filePath })
  );

  /** @deprecated Use IPC_DOMAINS.WORKSPACE with action: 'openPath' */
  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_PATH, async (_, filePath: string) =>
    handleOpenPath({ filePath })
  );
}

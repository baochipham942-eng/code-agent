// ============================================================================
// Workspace IPC Handlers - workspace:* 通道
// ============================================================================

import type { IpcMain, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { AgentOrchestrator } from '../agent/AgentOrchestrator';

/**
 * 注册 Workspace 相关 IPC handlers
 */
export function registerWorkspaceHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null,
  getOrchestrator: () => AgentOrchestrator | null
): void {
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SELECT_DIRECTORY, async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Working Directory',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const selectedPath = result.filePaths[0];

    const orchestrator = getOrchestrator();
    if (orchestrator) {
      orchestrator.setWorkingDirectory(selectedPath);
    }

    return selectedPath;
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_CURRENT, async () => {
    const orchestrator = getOrchestrator();
    if (!orchestrator) return null;
    return orchestrator.getWorkingDirectory();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_FILES, async (_, dirPath: string) => {
    const fs = await import('fs/promises');
    const pathModule = await import('path');

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        path: pathModule.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
      }));
    } catch (error) {
      console.error('Failed to list files:', error);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_READ_FILE, async (_, filePath: string) => {
    const fs = await import('fs/promises');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      console.error('Failed to read file:', error);
      throw error;
    }
  });

  // Shell handler
  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_PATH, async (_, filePath: string) => {
    const { shell } = await import('electron');
    return shell.openPath(filePath);
  });
}

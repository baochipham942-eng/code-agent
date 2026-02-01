// ============================================================================
// Background Task IPC Handlers - 后台任务管理
// ============================================================================

import { ipcMain, BrowserWindow } from 'electron';
import { createLogger } from '../services/infra/logger';
import { getBackgroundTaskManager } from '../session/backgroundTaskManager';
import { BACKGROUND_CHANNELS } from '../../shared/ipc/channels';
import type { BackgroundTaskInfo } from '../../shared/types/sessionState';

const logger = createLogger('Background-IPC');

/**
 * 注册 Background Task IPC 处理器
 */
export function registerBackgroundHandlers(getMainWindow: () => BrowserWindow | null): void {
  const manager = getBackgroundTaskManager();

  // 设置主窗口引用
  const mainWindow = getMainWindow();
  if (mainWindow) {
    manager.setMainWindow(mainWindow);
  }

  // 将会话移至后台
  ipcMain.handle(
    BACKGROUND_CHANNELS.MOVE_TO_BACKGROUND,
    async (_event, sessionId: string): Promise<boolean> => {
      logger.info('Moving session to background', { sessionId });
      return manager.moveToBackground(sessionId);
    }
  );

  // 将会话恢复到前台
  ipcMain.handle(
    BACKGROUND_CHANNELS.MOVE_TO_FOREGROUND,
    async (_event, sessionId: string): Promise<BackgroundTaskInfo | null> => {
      logger.info('Moving session to foreground', { sessionId });
      return manager.moveToForeground(sessionId);
    }
  );

  // 获取所有后台任务
  ipcMain.handle(
    BACKGROUND_CHANNELS.GET_TASKS,
    async (): Promise<BackgroundTaskInfo[]> => {
      return manager.getAllTasks();
    }
  );

  // 获取后台任务数量
  ipcMain.handle(
    BACKGROUND_CHANNELS.GET_COUNT,
    async (): Promise<number> => {
      return manager.getTaskCount();
    }
  );

  logger.info('Background task IPC handlers registered');
}

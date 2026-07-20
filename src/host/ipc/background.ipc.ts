// ============================================================================
// Background Task IPC Handlers - 后台任务管理
// ============================================================================

import { ipcHost, AppWindow } from '../platform';
import { createLogger } from '../services/infra/logger';
import { getBackgroundTaskManager } from '../session/backgroundTaskManager';
import { BACKGROUND_CHANNELS } from '../../shared/ipc/channels';
import type { BackgroundSessionInfo } from '../../shared/contract/sessionState';

const logger = createLogger('Background-IPC');

/**
 * 注册 Background Task IPC 处理器
 */
export function registerBackgroundHandlers(getMainWindow: () => AppWindow | null): void {
  const manager = getBackgroundTaskManager();

  // 设置主窗口引用
  const mainWindow = getMainWindow();
  if (mainWindow) {
    manager.setMainWindow(mainWindow);
  }

  // 将会话移至后台
  ipcHost.handle(
    BACKGROUND_CHANNELS.MOVE_TO_BACKGROUND,
    async (_event, sessionId: string): Promise<boolean> => {
      logger.info('Moving session to background', { sessionId });
      return manager.moveToBackground(sessionId);
    }
  );

  // 将会话恢复到前台
  ipcHost.handle(
    BACKGROUND_CHANNELS.MOVE_TO_FOREGROUND,
    async (_event, sessionId: string): Promise<BackgroundSessionInfo | null> => {
      logger.info('Moving session to foreground', { sessionId });
      return manager.moveToForeground(sessionId);
    }
  );

  // 获取所有后台任务
  ipcHost.handle(
    BACKGROUND_CHANNELS.GET_TASKS,
    async (): Promise<BackgroundSessionInfo[]> => {
      return manager.getAllTasks();
    }
  );

  // 获取后台任务数量
  ipcHost.handle(
    BACKGROUND_CHANNELS.GET_COUNT,
    async (): Promise<number> => {
      return manager.getTaskCount();
    }
  );

  logger.info('Background task IPC handlers registered');
}

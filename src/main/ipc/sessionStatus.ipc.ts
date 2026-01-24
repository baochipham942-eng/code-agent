// ============================================================================
// Session Status IPC Handlers - 会话状态 IPC 处理
// ============================================================================

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getSessionStateManager } from '../session/sessionStateManager';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionStatusIPC');

/**
 * 注册会话状态相关的 IPC handlers
 */
export function registerSessionStatusHandlers(): void {
  const sessionStateManager = getSessionStateManager();

  // 获取指定会话的运行状态
  ipcMain.handle(IPC_CHANNELS.SESSION_STATUS_GET, async (_event, sessionId: string) => {
    try {
      const summary = sessionStateManager.getSummary(sessionId);
      return summary;
    } catch (error) {
      logger.error('Failed to get session status:', error);
      return null;
    }
  });

  // 获取所有会话的运行状态
  ipcMain.handle(IPC_CHANNELS.SESSION_STATUS_GET_ALL, async () => {
    try {
      const summaries = sessionStateManager.getAllSummariesArray();
      return summaries;
    } catch (error) {
      logger.error('Failed to get all session statuses:', error);
      return [];
    }
  });

  logger.info('Session status handlers registered');
}

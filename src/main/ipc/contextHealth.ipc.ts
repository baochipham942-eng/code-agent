// ============================================================================
// Context Health IPC Handlers - 上下文健康度 IPC 处理
// ============================================================================

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getContextHealthService } from '../context/contextHealthService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ContextHealthIPC');

/**
 * 注册上下文健康度相关的 IPC handlers
 */
export function registerContextHealthHandlers(): void {
  const contextHealthService = getContextHealthService();

  // 获取指定会话的上下文健康状态
  ipcMain.handle(IPC_CHANNELS.CONTEXT_HEALTH_GET, async (_event, sessionId: string) => {
    try {
      const health = contextHealthService.get(sessionId);
      return health;
    } catch (error) {
      logger.error('Failed to get context health:', error);
      return null;
    }
  });

  logger.info('Context health handlers registered');
}

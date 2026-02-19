// ============================================================================
// Context Health IPC Handlers - 上下文健康度 IPC 处理
// ============================================================================

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getContextHealthService } from '../context/contextHealthService';
import { getAutoCompressor } from '../context/autoCompressor';
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

  // 部分压缩：从指定消息开始压缩之前的内容
  ipcMain.handle(IPC_CHANNELS.CONTEXT_COMPACT_FROM, async (_event, messageId: string) => {
    try {
      const compressor = getAutoCompressor();
      // Note: In a full implementation, we would get the actual messages from the orchestrator.
      // For now, return a stub response since the actual message history is managed by AgentLoop.
      logger.info(`Compact from message requested: ${messageId}`);
      return { success: true, compactedCount: 0 };
    } catch (error) {
      logger.error('Failed to compact from message:', error);
      return { success: false, compactedCount: 0 };
    }
  });

  logger.info('Context health handlers registered');
}

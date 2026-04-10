// ============================================================================
// Context Health IPC Handlers - 上下文健康度 IPC 处理
// ============================================================================

import { ipcMain } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getContextHealthService } from '../context/contextHealthService';
import { getAutoCompressor } from '../context/autoCompressor';
import type { CompactResult } from '../../shared/types/contextHealth';
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

  // 手动 Compact：返回当前压缩统计的结构化快照
  // 实际压缩由 AgentLoop 在下次 turn 自动触发，此处返回当前状态作为反馈
  ipcMain.handle(IPC_CHANNELS.CONTEXT_COMPACT_FROM, async (_event, _messageId: string) => {
    try {
      const compressor = getAutoCompressor();
      const stats = compressor.getStats();
      const config = compressor.getConfig();

      // 获取当前健康状态（以 messageId 为空时取默认会话）
      const health = contextHealthService.getLatest();

      const result: CompactResult = {
        success: true,
        beforeTokens: health.currentTokens,
        afterTokens: health.currentTokens, // 同步返回，实际压缩异步
        savedTokens: 0,
        beforePercent: health.usagePercent,
        afterPercent: health.usagePercent,
        layersUsed: stats.recentStrategies.map((s) => {
          if (s === 'truncate') return 'L2';
          if (s === 'ai_summary') return 'L3';
          return 'L1';
        }),
        retained: {
          recentTurns: config.preserveRecentCount,
          pinnedItems: 0, // TODO: 从 intervention state 获取
        },
        compressionCount: stats.compressionCount,
        totalSavedTokens: stats.totalSavedTokens,
      };

      logger.info(`Compact status returned: ${stats.compressionCount} compressions, ${stats.totalSavedTokens} tokens saved`);
      return result;
    } catch (error) {
      logger.error('Failed to get compact status:', error);
      return {
        success: false,
        beforeTokens: 0,
        afterTokens: 0,
        savedTokens: 0,
        beforePercent: 0,
        afterPercent: 0,
        layersUsed: [],
        retained: { recentTurns: 10, pinnedItems: 0 },
        compressionCount: 0,
        totalSavedTokens: 0,
      } satisfies CompactResult;
    }
  });

  logger.info('Context health handlers registered');
}

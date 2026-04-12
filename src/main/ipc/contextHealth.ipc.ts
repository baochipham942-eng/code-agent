// ============================================================================
// Context Health IPC Handlers - 上下文健康度 IPC 处理
// ============================================================================

import { ipcMain } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getContextHealthService } from '../context/contextHealthService';
import { getAutoCompressor } from '../context/autoCompressor';
import { estimateTokens } from '../context/tokenEstimator';
import type { CompactResult } from '../../shared/contract/contextHealth';
import type { AgentApplicationService } from '../../shared/contract/appService';
import type { CompressedMessage } from '../context/tokenOptimizer';
import type { TaskManager } from '../task';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ContextHealthIPC');

interface ContextHealthDependencies {
  getAppService: () => AgentApplicationService | null;
  getTaskManager: () => TaskManager | null;
}

/**
 * 注册上下文健康度相关的 IPC handlers
 */
export function registerContextHealthHandlers(deps: ContextHealthDependencies): void {
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

  // 手动 Compact：从指定消息处压缩之前的上下文
  ipcMain.handle(IPC_CHANNELS.CONTEXT_COMPACT_FROM, async (_event, messageId: string) => {
    try {
      const appService = deps.getAppService();
      if (!appService) {
        logger.warn('Compact requested but app service not available');
        return { success: false, beforeTokens: 0, afterTokens: 0, savedTokens: 0, beforePercent: 0, afterPercent: 0, layersUsed: [], retained: { recentTurns: 10, pinnedItems: 0 }, compressionCount: 0, totalSavedTokens: 0 } satisfies CompactResult;
      }

      const sessionId = appService.getCurrentSessionId();
      if (!sessionId) {
        logger.warn('Compact requested but no active session');
        return { success: false, beforeTokens: 0, afterTokens: 0, savedTokens: 0, beforePercent: 0, afterPercent: 0, layersUsed: [], retained: { recentTurns: 10, pinnedItems: 0 }, compressionCount: 0, totalSavedTokens: 0 } satisfies CompactResult;
      }

      // Get current messages from the session
      const messages = await appService.getMessages(sessionId);
      if (!messages || messages.length === 0) {
        logger.warn('Compact requested but no messages in session');
        return { success: false, beforeTokens: 0, afterTokens: 0, savedTokens: 0, beforePercent: 0, afterPercent: 0, layersUsed: [], retained: { recentTurns: 10, pinnedItems: 0 }, compressionCount: 0, totalSavedTokens: 0 } satisfies CompactResult;
      }

      // Convert Message[] to CompressedMessage[] for compactFrom
      const compressedMessages: CompressedMessage[] = messages.map((m) => ({
        role: m.role,
        content: m.content || '',
        timestamp: m.timestamp,
        id: m.id,
      }));

      // Calculate before tokens
      const beforeTokens = compressedMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      const health = contextHealthService.get(sessionId) || contextHealthService.getLatest();
      const maxTokens = health.maxTokens || 128000;
      const beforePercent = maxTokens > 0 ? Math.round((beforeTokens / maxTokens) * 1000) / 10 : 0;

      // Call the real compactFrom
      const compressor = getAutoCompressor();
      const compactResult = await compressor.compactFrom(messageId, compressedMessages, '');

      if (!compactResult.success) {
        logger.info('Compact from message returned unsuccessful (nothing to compact or message not found)');
        const stats = compressor.getStats();
        return {
          success: false,
          beforeTokens,
          afterTokens: beforeTokens,
          savedTokens: 0,
          beforePercent,
          afterPercent: beforePercent,
          layersUsed: [],
          retained: { recentTurns: compressor.getConfig().preserveRecentCount, pinnedItems: 0 },
          compressionCount: stats.compressionCount,
          totalSavedTokens: stats.totalSavedTokens,
        } satisfies CompactResult;
      }

      // Calculate after tokens
      const afterTokens = compactResult.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
      const savedTokens = beforeTokens - afterTokens;
      const afterPercent = maxTokens > 0 ? Math.round((afterTokens / maxTokens) * 1000) / 10 : 0;

      // Apply compacted messages back: rebuild as Message[] preserving original fields for kept messages
      const compactedMessages = compactResult.messages;
      const originalMessageMap = new Map(messages.map((m) => [m.id, m]));
      const newMessages = compactedMessages.map((cm) => {
        // If this message exists in the original, preserve it
        if (cm.id) {
          const original = originalMessageMap.get(cm.id);
          if (original) return original;
        }
        // Summary message created by compactFrom — build a minimal Message
        return {
          id: `compact-summary-${Date.now()}`,
          role: cm.role as import('../../shared/contract').MessageRole,
          content: cm.content,
          timestamp: Date.now(),
        };
      });

      // Set compacted messages back on the orchestrator
      const taskManager = deps.getTaskManager();
      if (taskManager) {
        const orchestrator = taskManager.getOrchestrator(sessionId);
        if (orchestrator) {
          orchestrator.setMessages(newMessages);
          logger.info(`Compact applied: ${compactResult.compactedCount} messages compacted, ${savedTokens} tokens saved`);
        } else {
          logger.warn('Orchestrator not found for session — compact result not applied to runtime');
        }
      } else {
        logger.warn('TaskManager not available — compact result not applied to runtime');
      }

      const stats = compressor.getStats();
      const result: CompactResult = {
        success: true,
        beforeTokens,
        afterTokens,
        savedTokens,
        beforePercent,
        afterPercent,
        layersUsed: ['L3'], // compactFrom uses AI summary
        retained: {
          recentTurns: compressor.getConfig().preserveRecentCount,
          pinnedItems: 0,
        },
        compressionCount: stats.compressionCount + 1,
        totalSavedTokens: stats.totalSavedTokens + savedTokens,
      };

      logger.info(`Manual compact completed: ${compactResult.compactedCount} messages compacted, ${savedTokens} tokens saved (${beforeTokens} → ${afterTokens})`);
      return result;
    } catch (error) {
      logger.error('Failed to compact from message:', error);
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

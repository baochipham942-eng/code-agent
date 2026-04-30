// ============================================================================
// Context Health IPC Handlers - 上下文健康度 IPC 处理
// ============================================================================

import { ipcMain } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getContextHealthService } from '../context/contextHealthService';
import { getAutoCompressor } from '../context/autoCompressor';
import { CompressionState } from '../context/compressionState';
import { getContextEventLedger } from '../context/contextEventLedger';
import { estimateTokens } from '../context/tokenEstimator';
import type { CompactResult } from '../../shared/contract/contextHealth';
import type { AgentApplicationService } from '../../shared/contract/appService';
import type { CompressedMessage } from '../context/tokenOptimizer';
import type { TaskManager } from '../task';
import { createLogger } from '../services/infra/logger';
import { getSessionManager } from '../services';
import { getDatabase } from '../services/core/databaseService';
import { DEFAULT_MODEL } from '../../shared/constants';
import type { ContextHealthState } from '../../shared/contract/contextHealth';
import type { Message } from '../../shared/contract';

const logger = createLogger('ContextHealthIPC');

interface ContextHealthDependencies {
  getAppService: () => AgentApplicationService | null;
  getTaskManager: () => TaskManager | null;
}

function hasMeasuredUsage(health: ContextHealthState | null | undefined): health is ContextHealthState {
  return Boolean(health && health.currentTokens > 0);
}

function toContextMessages(messages: Message[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content || '',
    toolResults: message.toolResults?.map((result) => ({
      output: result.output,
      error: result.error,
    })),
  }));
}

function resolveModelForSession(appService: AgentApplicationService, sessionId: string): string {
  const override = appService.getModelOverride(sessionId)?.model;
  if (override) {
    return override;
  }

  try {
    return getDatabase().getSession(sessionId)?.modelConfig?.model || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export async function resolveContextHealthForSession(
  deps: Pick<ContextHealthDependencies, 'getAppService'>,
  sessionId: string,
): Promise<ContextHealthState> {
  const contextHealthService = getContextHealthService();
  const cached = contextHealthService.get(sessionId);

  if (hasMeasuredUsage(cached)) {
    return cached;
  }

  const appService = deps.getAppService();
  if (!appService) {
    return cached;
  }

  try {
    const messages = await appService.getMessages(sessionId);
    if (!messages || messages.length === 0) {
      return cached;
    }

    const model = resolveModelForSession(appService, sessionId);
    return contextHealthService.update(
      sessionId,
      toContextMessages(messages),
      '',
      model,
    );
  } catch (error) {
    logger.warn('Failed to derive context health from session messages:', {
      sessionId,
      error,
    });
    return cached;
  }
}

/**
 * 注册上下文健康度相关的 IPC handlers
 */
export function registerContextHealthHandlers(deps: ContextHealthDependencies): void {
  const contextHealthService = getContextHealthService();

  // 获取指定会话的上下文健康状态
  ipcMain.handle(IPC_CHANNELS.CONTEXT_HEALTH_GET, async (_event, sessionId: string) => {
    try {
      return await resolveContextHealthForSession(deps, sessionId);
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
      const compactedAt = Date.now();
      let summaryIndex = 0;
      const newMessages = compactedMessages.map((cm) => {
        // If this message exists in the original, preserve it
        if (cm.id) {
          const original = originalMessageMap.get(cm.id);
          if (original) return original;
        }
        // Summary message created by compactFrom — build a minimal Message
        const summaryId = `compact-summary-${compactedAt}-${summaryIndex++}`;
        return {
          id: summaryId,
          role: cm.role as import('../../shared/contract').MessageRole,
          content: cm.content,
          timestamp: compactedAt,
          compaction: {
            type: 'compaction' as const,
            content: cm.content,
            timestamp: compactedAt,
            compactedMessageCount: compactResult.compactedCount,
            compactedTokenCount: savedTokens,
          },
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

      try {
        await getSessionManager().replaceMessages(sessionId, newMessages);

        const compactedMessageIds = newMessages
          .filter((message) => message.compaction)
          .map((message) => message.id);
        if (compactedMessageIds.length > 0) {
          const compressionState = new CompressionState();
          compressionState.applyCommit({
            layer: 'autocompact',
            operation: 'compact',
            targetMessageIds: compactedMessageIds,
            timestamp: compactedAt,
            metadata: {
              kind: 'manual_compact',
              compactedMessageCount: compactResult.compactedCount,
              compactedTokenCount: savedTokens,
            },
          });
          getContextEventLedger().upsertCompressionEvents(
            sessionId,
            undefined,
            compressionState.getCommitLog(),
          );
          getDatabase().saveSessionRuntimeState(sessionId, {
            compressionStateJson: compressionState.serialize(),
          });
        }
      } catch (error) {
        logger.warn('Manual compact completed in runtime but failed to persist compacted session', error);
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

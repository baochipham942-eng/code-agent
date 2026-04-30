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
import {
  getCompressionStatus,
  type CompactResult,
  type CompressionStats,
} from '../../shared/contract/contextHealth';
import type { AgentApplicationService } from '../../shared/contract/appService';
import type { CompressedMessage } from '../context/tokenOptimizer';
import type { TaskManager } from '../task';
import { createLogger } from '../services/infra/logger';
import { getSessionManager } from '../services';
import { getDatabase } from '../services/core/databaseService';
import { DEFAULT_MODEL } from '../../shared/constants';
import type { ContextHealthState } from '../../shared/contract/contextHealth';
import type { Message, MessageRole } from '../../shared/contract';

const logger = createLogger('ContextHealthIPC');

interface ContextHealthDependencies {
  getAppService: () => AgentApplicationService | null;
  getTaskManager: () => TaskManager | null;
  getSystemPromptForSession?: (sessionId: string) => string | null | undefined;
}

function emptyCompactResult(): CompactResult {
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
  };
}

function hasMeasuredUsage(health: ContextHealthState | null | undefined): health is ContextHealthState {
  return Boolean(health && health.currentTokens > 0);
}

function toContextMessages(messages: Message[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content || '',
    toolCalls: message.toolCalls,
    toolResults: message.toolResults?.map((result) => ({
      output: result.output,
      error: result.error,
    })),
  }));
}

function serializeForCompaction(message: Message): string {
  const parts: string[] = [];
  if (message.content) {
    parts.push(message.content);
  }

  if (message.toolCalls?.length) {
    parts.push(`[tool calls]\n${JSON.stringify(message.toolCalls)}`);
  }

  if (message.toolResults?.length) {
    parts.push(`[tool results]\n${JSON.stringify(message.toolResults.map((result) => ({
      toolCallId: result.toolCallId,
      output: result.output,
      error: result.error,
    })))}`);
  }

  return parts.join('\n\n');
}

function toCompressedMessages(messages: Message[]): CompressedMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: serializeForCompaction(message),
    timestamp: message.timestamp,
    id: message.id,
  }));
}

function resolveManualCompactSessionId(
  appService: AgentApplicationService | null,
  requestedSessionId?: string,
): string | null {
  const explicitSessionId = requestedSessionId?.trim();
  if (explicitSessionId) {
    return explicitSessionId;
  }

  const appSessionId = appService?.getCurrentSessionId();
  if (appSessionId) {
    return appSessionId;
  }

  try {
    return getSessionManager().getCurrentSessionId();
  } catch {
    return null;
  }
}

function resolveCompactAnchorMessageId(
  messages: Message[],
  requestedMessageId: string | undefined,
  preserveRecentCount: number,
): string | null {
  const explicitMessageId = requestedMessageId?.trim();
  if (explicitMessageId) {
    return explicitMessageId;
  }

  if (messages.length < 3) {
    return null;
  }

  const preservedCount = Math.min(
    preserveRecentCount,
    Math.max(1, messages.length - 2),
  );
  const anchorIndex = Math.max(1, messages.length - preservedCount);
  return messages[anchorIndex]?.id ?? null;
}

async function resolveMessagesForSession(
  appService: AgentApplicationService | null,
  sessionId: string,
): Promise<Message[] | null> {
  if (appService) {
    return appService.getMessages(sessionId);
  }

  try {
    return await getSessionManager().getMessages(sessionId);
  } catch {
    // Web mode may not have an AppService, but the SessionManager/DB path is
    // still available after backend initialization.
  }

  try {
    return getDatabase().getMessages(sessionId);
  } catch {
    return null;
  }
}

function resolveModelForSession(appService: AgentApplicationService | null, sessionId: string): string {
  const override = appService?.getModelOverride(sessionId)?.model;
  if (override) {
    return override;
  }

  try {
    return getDatabase().getSession(sessionId)?.modelConfig?.model || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

function resolveLatestSystemPromptFromTelemetry(sessionId: string): string {
  try {
    const db = getDatabase().getDb();
    if (!db) return '';
    const row = db.prepare(`
      SELECT sp.content AS content
      FROM telemetry_turns tt
      JOIN system_prompt_cache sp ON sp.hash = tt.system_prompt_hash
      WHERE tt.session_id = ?
        AND tt.system_prompt_hash IS NOT NULL
      ORDER BY tt.start_time DESC
      LIMIT 1
    `).get(sessionId) as { content?: string } | undefined;
    return row?.content || '';
  } catch {
    return '';
  }
}

function resolveSystemPromptForSession(
  deps: Pick<ContextHealthDependencies, 'getSystemPromptForSession'>,
  sessionId: string,
): string {
  const injected = deps.getSystemPromptForSession?.(sessionId);
  if (injected) return injected;
  return resolveLatestSystemPromptFromTelemetry(sessionId);
}

export async function resolveContextHealthForSession(
  deps: Pick<ContextHealthDependencies, 'getAppService' | 'getSystemPromptForSession'>,
  sessionId: string,
): Promise<ContextHealthState> {
  const contextHealthService = getContextHealthService();
  const cached = contextHealthService.get(sessionId);

  if (hasMeasuredUsage(cached)) {
    return cached;
  }

  try {
    const appService = deps.getAppService();
    const messages = await resolveMessagesForSession(appService, sessionId);
    if (!messages || messages.length === 0) {
      return cached;
    }

    const model = resolveModelForSession(appService, sessionId);
    const systemPrompt = resolveSystemPromptForSession(deps, sessionId);
    return contextHealthService.update(
      sessionId,
      toContextMessages(messages),
      systemPrompt,
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

async function compactSession(
  deps: ContextHealthDependencies,
  options: { sessionId?: string; messageId?: string },
): Promise<CompactResult> {
  const contextHealthService = getContextHealthService();
  const appService = deps.getAppService();
  const sessionId = resolveManualCompactSessionId(appService, options.sessionId);
  if (!sessionId) {
    logger.warn('Compact requested but no active session');
    return emptyCompactResult();
  }

  const messages = await resolveMessagesForSession(appService, sessionId);
  if (!messages || messages.length === 0) {
    logger.warn('Compact requested but no messages in session');
    return emptyCompactResult();
  }

  const compressor = getAutoCompressor();
  const anchorMessageId = resolveCompactAnchorMessageId(
    messages,
    options.messageId,
    compressor.getConfig().preserveRecentCount,
  );
  if (!anchorMessageId) {
    logger.info('Compact requested but the session is too short to compact');
    return emptyCompactResult();
  }

  const compressedMessages = toCompressedMessages(messages);
  const beforeTokens = compressedMessages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  const health = contextHealthService.get(sessionId) || contextHealthService.getLatest();
  const maxTokens = health.maxTokens || 128000;
  const beforePercent = maxTokens > 0 ? Math.round((beforeTokens / maxTokens) * 1000) / 10 : 0;

  const compactResult = await compressor.compactFrom(anchorMessageId, compressedMessages, '');
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

  const afterTokens = compactResult.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  const savedTokens = beforeTokens - afterTokens;
  const afterPercent = maxTokens > 0 ? Math.round((afterTokens / maxTokens) * 1000) / 10 : 0;

  const originalMessageMap = new Map(messages.map((message) => [message.id, message]));
  const compactedAt = Date.now();
  let summaryIndex = 0;
  const newMessages: Message[] = compactResult.messages.map((compressedMessage) => {
    if (compressedMessage.id) {
      const original = originalMessageMap.get(compressedMessage.id);
      if (original) return original;
    }

    const summaryId = `compact-summary-${compactedAt}-${summaryIndex++}`;
    return {
      id: summaryId,
      role: compressedMessage.role as MessageRole,
      content: compressedMessage.content,
      timestamp: compactedAt,
      compaction: {
        type: 'compaction' as const,
        content: compressedMessage.content,
        timestamp: compactedAt,
        compactedMessageCount: compactResult.compactedCount,
        compactedTokenCount: savedTokens,
      },
    };
  });

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
  const compressionStats: CompressionStats = {
    status: getCompressionStatus(afterPercent),
    lastCompressionAt: compactedAt,
    compressionCount: stats.compressionCount + 1,
    totalSavedTokens: stats.totalSavedTokens + savedTokens,
  };
  const model = resolveModelForSession(appService, sessionId);
  const systemPrompt = resolveSystemPromptForSession(deps, sessionId);
  contextHealthService.update(
    sessionId,
    toContextMessages(newMessages),
    systemPrompt,
    model,
    compressionStats,
  );

  const result: CompactResult = {
    success: true,
    beforeTokens,
    afterTokens,
    savedTokens,
    beforePercent,
    afterPercent,
    layersUsed: ['L3'],
    retained: {
      recentTurns: compressor.getConfig().preserveRecentCount,
      pinnedItems: 0,
    },
    compressionCount: compressionStats.compressionCount,
    totalSavedTokens: compressionStats.totalSavedTokens,
  };

  logger.info(`Manual compact completed: ${compactResult.compactedCount} messages compacted, ${savedTokens} tokens saved (${beforeTokens} → ${afterTokens})`);
  return result;
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
      return await compactSession(deps, { messageId });
    } catch (error) {
      logger.error('Failed to compact from message:', error);
      return emptyCompactResult();
    }
  });

  // 手动 Compact：主动压缩当前会话，保留最近消息
  ipcMain.handle(IPC_CHANNELS.CONTEXT_COMPACT_CURRENT, async (_event, sessionId?: string) => {
    try {
      return await compactSession(deps, { sessionId });
    } catch (error) {
      logger.error('Failed to compact current session:', error);
      return emptyCompactResult();
    }
  });

  logger.info('Context health handlers registered');
}

// ============================================================================
// Context Health IPC Handlers - 上下文健康度 IPC 处理
// ============================================================================

import { ipcHost } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getContextHealthService } from '../context/contextHealthService';
import { getAutoCompressor } from '../context/autoCompressor';
import { CompressionState } from '../context/compressionState';
import { getContextEventLedger } from '../context/contextEventLedger';
import { estimateTokens } from '../context/tokenEstimator';
import { compactMessagesWithSummary } from '../context/compactionService';
import { getCompactModelInfo, resetCompactModel } from '../context/compactModel';
import {
  type ContextCompressionChannelState,
  type ContextCompressionConfig,
  type ContextCompressionConfigPatch,
  getCompressionStatus,
  type CompactResult,
  type CompressionStats,
} from '../../shared/contract/contextHealth';
import type { AgentApplicationService } from '../../shared/contract/appService';
import type { CompressedMessage } from '../context/tokenOptimizer';
import type { TaskManager } from '../task';
import { createLogger } from '../services/infra/logger';
import { getConfigService, getSessionManager } from '../services';
import { getDatabase } from '../services/core/databaseService';
import { DEFAULT_MODEL, DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../shared/constants';
import type { ContextHealthState } from '../../shared/contract/contextHealth';
import type { Message } from '../../shared/contract';
import type { ModelConfig } from '../../shared/contract/model';
import type { AppSettings } from '../../shared/contract/settings';

const logger = createLogger('ContextHealthIPC');

const DEFAULT_CONTEXT_COMPRESSION_CONFIG: ContextCompressionConfig = {
  enabled: true,
  warningThreshold: 0.75,
  criticalThreshold: 0.85,
  preserveRecentCount: 10,
  triggerTokens: 100000,
  compactProvider: 'moonshot',
  compactModel: DEFAULT_MODELS.compact,
  auditEnabled: true,
};

interface ContextHealthDependencies {
  getAppService: () => AgentApplicationService | null;
  getTaskManager: () => TaskManager | null;
  getSystemPromptForSession?: (sessionId: string) => string | null | undefined;
}

function clampRatio(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(0.95, Math.max(0.1, value));
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeCompressionConfig(config?: Partial<ContextCompressionConfig>): ContextCompressionConfig {
  const merged = { ...DEFAULT_CONTEXT_COMPRESSION_CONFIG, ...(config || {}) };
  const warningThreshold = clampRatio(merged.warningThreshold, DEFAULT_CONTEXT_COMPRESSION_CONFIG.warningThreshold);
  const criticalThreshold = Math.max(
    warningThreshold,
    clampRatio(merged.criticalThreshold, DEFAULT_CONTEXT_COMPRESSION_CONFIG.criticalThreshold),
  );
  const triggerTokens = merged.triggerTokens === undefined
    ? undefined
    : clampInt(merged.triggerTokens, DEFAULT_CONTEXT_COMPRESSION_CONFIG.triggerTokens ?? 100000, 16000, 1000000);

  return {
    enabled: merged.enabled !== false,
    warningThreshold,
    criticalThreshold,
    preserveRecentCount: clampInt(merged.preserveRecentCount, DEFAULT_CONTEXT_COMPRESSION_CONFIG.preserveRecentCount, 2, 50),
    ...(triggerTokens ? { triggerTokens } : {}),
    compactProvider: typeof merged.compactProvider === 'string' && merged.compactProvider.trim()
      ? merged.compactProvider.trim()
      : DEFAULT_CONTEXT_COMPRESSION_CONFIG.compactProvider,
    compactModel: typeof merged.compactModel === 'string' && merged.compactModel.trim()
      ? merged.compactModel.trim()
      : DEFAULT_CONTEXT_COMPRESSION_CONFIG.compactModel,
    auditEnabled: merged.auditEnabled !== false,
  };
}

function getPersistedCompressionConfig(): ContextCompressionConfig {
  try {
    return normalizeCompressionConfig(getConfigService().getSettings().contextCompression);
  } catch {
    return { ...DEFAULT_CONTEXT_COMPRESSION_CONFIG };
  }
}

function toAppSettingsPatch(config: ContextCompressionConfig): Partial<AppSettings> {
  return { contextCompression: config };
}

function applyCompressionConfig(config: ContextCompressionConfig): void {
  getAutoCompressor().updateConfig({
    enabled: config.enabled,
    warningThreshold: config.warningThreshold,
    criticalThreshold: config.criticalThreshold,
    preserveRecentCount: config.preserveRecentCount,
    triggerTokens: config.triggerTokens,
  });
  resetCompactModel();
}

function getCompressionChannelState(config = getPersistedCompressionConfig()): ContextCompressionChannelState {
  applyCompressionConfig(config);
  const compressor = getAutoCompressor();
  const stats = compressor.getStats();
  const compactModel = getCompactModelInfo();

  return {
    config,
    runtime: {
      compressionCount: stats.compressionCount,
      totalSavedTokens: stats.totalSavedTokens,
      lastCompressionAt: stats.lastCompressionAt,
      recentStrategies: stats.recentStrategies,
    },
    compactModel: {
      provider: compactModel?.provider ?? config.compactProvider,
      model: compactModel?.model ?? config.compactModel,
      configured: Boolean(compactModel),
    },
    features: {
      audit: config.auditEnabled ? 'enabled' : 'disabled',
      manifest: 'enabled',
      hooks: 'available',
    },
  };
}

async function updateCompressionConfig(patch: ContextCompressionConfigPatch): Promise<ContextCompressionChannelState> {
  const nextConfig = normalizeCompressionConfig({
    ...getPersistedCompressionConfig(),
    ...patch,
  });
  await getConfigService().updateSettings(toAppSettingsPatch(nextConfig));
  return getCompressionChannelState(nextConfig);
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
  let anchorIndex = Math.max(1, messages.length - preservedCount);
  // compact-current generates an anchor automatically. Treat it as an upper
  // bound so the active user instruction always stays on the preserved side;
  // compactionService applies the tool call/result protocol clamp afterwards.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      anchorIndex = Math.min(anchorIndex, index);
      break;
    }
  }
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

function resolveModelConfigForSession(
  appService: AgentApplicationService | null,
  sessionId: string,
): Pick<ModelConfig, 'provider' | 'model'> {
  const override = appService?.getModelOverride(sessionId);
  if (override?.model) {
    return {
      provider: override.provider || DEFAULT_PROVIDER,
      model: override.model,
    };
  }

  try {
    const modelConfig = getDatabase().getSession(sessionId)?.modelConfig;
    if (modelConfig?.model) {
      return {
        provider: modelConfig.provider || DEFAULT_PROVIDER,
        model: modelConfig.model,
      };
    }
  } catch {
    // Fall back to defaults below.
  }

  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

function resolveHookManagerForSession(deps: ContextHealthDependencies, sessionId: string) {
  try {
    return deps.getTaskManager()?.getOrchestrator(sessionId)?.getHookManager?.();
  } catch {
    return undefined;
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
  options: { sessionId?: string; messageId?: string; focusText?: string },
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

  const compressionConfig = getPersistedCompressionConfig();
  applyCompressionConfig(compressionConfig);
  const anchorMessageId = resolveCompactAnchorMessageId(
    messages,
    options.messageId,
    compressionConfig.preserveRecentCount,
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

  const systemPrompt = resolveSystemPromptForSession(deps, sessionId);
  const modelConfig = resolveModelConfigForSession(appService, sessionId);
  const compaction = await compactMessagesWithSummary({
    sessionId,
    source: options.messageId ? 'manual_from_message' : 'manual_current',
    messages,
    anchorMessageId,
    preserveRecentCount: compressionConfig.preserveRecentCount,
    systemPrompt,
    modelConfig,
    hookManager: resolveHookManagerForSession(deps, sessionId),
    usagePercent: beforePercent,
    skipAudit: !compressionConfig.auditEnabled,
    focusText: options.focusText,
  });

  if (!compaction.success || !compaction.newMessages || !compaction.summaryMessage || !compaction.block) {
    logger.info('Compact returned unsuccessful', {
      sessionId,
      reason: compaction.reason,
    });
    return {
      success: false,
      reason: compaction.reason,
      beforeTokens,
      afterTokens: beforeTokens,
      savedTokens: 0,
      beforePercent,
      afterPercent: beforePercent,
      layersUsed: [],
      retained: { recentTurns: compressionConfig.preserveRecentCount, pinnedItems: 0 },
      compressionCount: health.compression?.compressionCount ?? 0,
      totalSavedTokens: health.compression?.totalSavedTokens ?? 0,
      warnings: compaction.warnings,
    } satisfies CompactResult;
  }

  const newMessages = compaction.newMessages;
  const afterTokens = compaction.afterTokens;
  const savedTokens = compaction.savedTokens;
  const afterPercent = maxTokens > 0 ? Math.round((afterTokens / maxTokens) * 1000) / 10 : 0;
  const compactedAt = compaction.block.timestamp;

  const taskManager = deps.getTaskManager();
  if (taskManager) {
    const orchestrator = taskManager.getOrchestrator(sessionId);
    if (orchestrator) {
      orchestrator.setMessages(newMessages);
      logger.info(`Compact applied: ${compaction.block.compactedMessageCount} messages compacted, ${savedTokens} tokens saved`);
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
          kind: compaction.block.source || 'manual_compact',
          compactedMessageCount: compaction.block.compactedMessageCount,
          compactedTokenCount: savedTokens,
          anchorMessageId: compaction.block.anchorMessageId,
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

  const compressionStats: CompressionStats = {
    status: getCompressionStatus(afterPercent),
    lastCompressionAt: compactedAt,
    compressionCount: (health.compression?.compressionCount ?? 0) + 1,
    totalSavedTokens: (health.compression?.totalSavedTokens ?? 0) + savedTokens,
  };
  const model = resolveModelForSession(appService, sessionId);
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
      recentTurns: compressionConfig.preserveRecentCount,
      pinnedItems: 0,
    },
    compressionCount: compressionStats.compressionCount,
    totalSavedTokens: compressionStats.totalSavedTokens,
    summaryMessageId: compaction.summaryMessage.id,
    compactedMessageCount: compaction.block.compactedMessageCount,
    preservedMessageCount: newMessages.length - 1,
    provider: compaction.block.provider,
    model: compaction.block.model,
    warnings: compaction.warnings,
  };

  logger.info(`Manual compact completed: ${compaction.block.compactedMessageCount} messages compacted, ${savedTokens} tokens saved (${beforeTokens} → ${afterTokens})`);
  return result;
}

/**
 * 注册上下文健康度相关的 IPC handlers
 */
export function registerContextHealthHandlers(deps: ContextHealthDependencies): void {
  const contextHealthService = getContextHealthService();
  applyCompressionConfig(getPersistedCompressionConfig());

  ipcHost.handle(IPC_CHANNELS.CONTEXT_COMPRESSION_CONFIG_GET, async () => {
    try {
      return getCompressionChannelState();
    } catch (error) {
      logger.error('Failed to get context compression config:', error);
      return getCompressionChannelState(DEFAULT_CONTEXT_COMPRESSION_CONFIG);
    }
  });

  ipcHost.handle(IPC_CHANNELS.CONTEXT_COMPRESSION_CONFIG_SET, async (_event, patch: ContextCompressionConfigPatch) => {
    try {
      return await updateCompressionConfig(patch);
    } catch (error) {
      logger.error('Failed to update context compression config:', error);
      return getCompressionChannelState();
    }
  });

  // 获取指定会话的上下文健康状态
  ipcHost.handle(IPC_CHANNELS.CONTEXT_HEALTH_GET, async (_event, sessionId: string) => {
    try {
      return await resolveContextHealthForSession(deps, sessionId);
    } catch (error) {
      logger.error('Failed to get context health:', error);
      return null;
    }
  });

  // 手动 Compact：从指定消息处压缩之前的上下文
  ipcHost.handle(IPC_CHANNELS.CONTEXT_COMPACT_FROM, async (_event, messageId: string) => {
    try {
      return await compactSession(deps, { messageId });
    } catch (error) {
      logger.error('Failed to compact from message:', error);
      return emptyCompactResult();
    }
  });

  // 手动 Compact：主动压缩当前会话，保留最近消息
  ipcHost.handle(IPC_CHANNELS.CONTEXT_COMPACT_CURRENT, async (_event, sessionId?: string, focusText?: string) => {
    try {
      return await compactSession(deps, { sessionId, focusText });
    } catch (error) {
      logger.error('Failed to compact current session:', error);
      return emptyCompactResult();
    }
  });

  logger.info('Context health handlers registered');
}

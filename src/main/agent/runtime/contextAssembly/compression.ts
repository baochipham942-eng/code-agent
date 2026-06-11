// ContextAssembly - Context health tracking and hard-threshold compression.
import type { AgentEvent, Message } from '../../../../shared/contract';
import { DEFAULT_MODELS } from '../../../../shared/constants';
import { getContextHealthService } from '../../../context/contextHealthService';
import { CompressionState } from '../../../context/compressionState';
import { getContextEventLedger } from '../../../context/contextEventLedger';
import { compactMessagesWithSummary } from '../../../context/compactionService';
import { estimateTokens } from '../../../context/tokenOptimizer';
import { assessContextPressure } from '../../../context/contextPressureController';
import { tryInsertCheckpointRebuildBoundary } from '../../../context/checkpoint/runtimeBoundary';
import { readExistingCheckpointStore, resolveCheckpointStorePaths } from '../../../context/checkpoint/store';
import { validateCheckpointDocument } from '../../../context/checkpoint/validator';
import { logCollector } from '../../../mcp/logCollector.js';
import { fileReadTracker } from '../../../tools/fileReadTracker';
import { dataFingerprintStore } from '../../../tools/dataFingerprint';
import {
  getCoreToolDefinitions,
  getLoadedDeferredToolDefinitions,
} from '../../../tools/dispatch/toolDefinitions';
import { getSessionManager } from '../../../services';
import { getIncompleteTasks } from '../../../services/planning/taskStore';
import { getSessionTodos } from '../../../agent/todoParser';
import type { ContextAssemblyCtx } from './shared';
import { cachedReaddirSync, logger } from './shared';
import { persistRuntimeState } from '../runtimeStatePersistence';
import { getCheckpointWriterService } from '../../checkpointWriterService';

let toolDefTokensCache: { signature: string; tokens: number } | null = null;

function estimateActiveToolDefinitionsTokens(): number {
  try {
    const core = getCoreToolDefinitions();
    const deferred = getLoadedDeferredToolDefinitions();
    const all = [...core, ...deferred];
    const signature = `${all.length}:${all.map((tool) => tool.name).join(',')}`;
    if (toolDefTokensCache?.signature === signature) {
      return toolDefTokensCache.tokens;
    }
    const serialized = JSON.stringify(all.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })));
    const tokens = estimateTokens(serialized);
    toolDefTokensCache = { signature, tokens };
    return tokens;
  } catch (error) {
    logger.debug('estimateActiveToolDefinitionsTokens failed, returning 0:', error);
    return 0;
  }
}

async function persistCompactionTranscriptMarker(
  ctx: ContextAssemblyCtx,
  message: Message,
): Promise<void> {
  let persisted = false;

  if (ctx.runtime.persistMessage) {
    try {
      await ctx.runtime.persistMessage(message);
      persisted = true;
    } catch (error) {
      logger.warn('[AgentLoop] Persisting compaction marker via callback failed; falling back to session manager', {
        sessionId: ctx.runtime.sessionId,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!persisted && ctx.runtime.sessionId) {
    try {
      await getSessionManager().addMessageToSession(ctx.runtime.sessionId, message);
    } catch (error) {
      logger.warn('[AgentLoop] Failed to persist compaction marker', {
        sessionId: ctx.runtime.sessionId,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function commitCompactionBlock(
  ctx: ContextAssemblyCtx,
  block: NonNullable<Awaited<ReturnType<typeof compactMessagesWithSummary>>['block']>,
  preserveCount: number,
  options: {
    currentTokens?: number;
    compactionStartTime?: number;
    emitCompacted?: boolean;
    survivorReason: string;
  },
): Promise<void> {
  // === 注入文件状态 + TODO 恢复上下文 ===
  let recoveryContext = '';

  const recentFiles = fileReadTracker.getRecentFiles(10);
  if (recentFiles.length > 0) {
    recoveryContext += '\n\n## 最近读取的文件\n';
    recoveryContext += recentFiles.map(f => `- ${f.path}`).join('\n');
  }

  const todos = getSessionTodos(ctx.runtime.sessionId);
  const pendingTodos = todos.filter(t => t.status !== 'completed');
  if (pendingTodos.length > 0) {
    recoveryContext += '\n\n## 未完成的任务\n';
    recoveryContext += pendingTodos.map(t =>
      `- [${t.status === 'in_progress' ? '进行中' : '待处理'}] ${t.content}`
    ).join('\n');
  }

  const incompleteTasks = getIncompleteTasks(ctx.runtime.sessionId);
  if (incompleteTasks.length > 0) {
    recoveryContext += '\n\n## 未完成的子任务\n';
    recoveryContext += incompleteTasks.map(t =>
      `- [${t.status}] ${t.subject}`
    ).join('\n');
  }

  // 注入数据指纹摘要（防止多轮对话中虚构数据）
  const dataFingerprint = dataFingerprintStore.toSummary();
  if (dataFingerprint) {
    recoveryContext += '\n\n' + dataFingerprint;
  }

  // 注入输出目录文件列表（防止多轮对话压缩后遗忘已创建文件）
  try {
    const allOutputFiles = cachedReaddirSync(ctx.runtime.workingDirectory)
      .filter(f => /\.(xlsx|xls|csv|png|pdf|json)$/i.test(f))
      .sort();
    if (allOutputFiles.length > 0) {
      recoveryContext += '\n\n## 当前输出目录中已有的文件\n';
      recoveryContext += allOutputFiles.map(f => `- ${f}`).join('\n');

      recoveryContext += '\n\n⚠️ 以上文件已存在于工作目录中，请在此基础上修改，不要重新创建';
    }
  } catch { /* ignore if directory listing fails */ }

  if (recoveryContext) {
    block.content += recoveryContext;
  }
  // === 恢复上下文注入完毕 ===

  // 将 compaction block 作为消息保留在历史中
  // content 只存压缩 summary 本身；user-facing 的"已压缩 N 条 / 节省 X tokens"通过
  // context_compacted SSE event 推前端（见下方 onEvent），不要混进 content，
  // 否则下一次压缩会把这条 toast 文案 summarize 进新 summary，造成递归污染。
  const compactionMessage: Message = {
    id: ctx.generateId(),
    role: 'system',
    content: block.content,
    timestamp: block.timestamp,
    compaction: block,
  };
  getContextEventLedger().upsertEvents([{
    id: '',
    sessionId: ctx.runtime.sessionId,
    agentId: ctx.runtime.agentId,
    messageId: compactionMessage.id,
    category: 'compression_survivor',
    action: 'compressed',
    sourceKind: 'compression_survivor',
    sourceDetail: 'autocompact:compaction_block',
    layer: 'autocompact',
    reason: options.survivorReason,
    timestamp: block.timestamp,
  }]);

  // Layer 2: only compact the runtime model context. The durable transcript stays
  // append-only below, otherwise old user prompts disappear from session replay.
  const boundary = ctx.runtime.messages.length - preserveCount;
  if (boundary > 0) {
    ctx.runtime.messages.splice(0, boundary, compactionMessage);
    logger.info(`[AgentLoop] Layer 2: spliced ${boundary} old messages, kept ${preserveCount} recent + 1 compaction`);
  } else {
    // 消息太少，仅追加
    ctx.runtime.messages.push(compactionMessage);
  }
  ctx.recordContextEventsForMessage(compactionMessage);
  try {
    await persistCompactionTranscriptMarker(ctx, compactionMessage);
  } catch (error) {
    logger.warn('[AgentLoop] Auto compression updated runtime but failed to persist compaction marker', error);
  }

  const nextCompressionState = new CompressionState();
  nextCompressionState.applyCommit({
    layer: 'autocompact',
    operation: 'compact',
    targetMessageIds: [compactionMessage.id],
    timestamp: block.timestamp,
    metadata: {
      compactedMessageCount: block.compactedMessageCount,
      compactedTokenCount: block.compactedTokenCount,
      kind: 'compaction_block',
    },
  });
  ctx.runtime.compressionState = nextCompressionState;
  persistRuntimeState(ctx.runtime, { compressionState: true, persistentSystemContext: false });
  getContextEventLedger().upsertCompressionEvents(
    ctx.runtime.sessionId,
    ctx.runtime.agentId,
    nextCompressionState.getCommitLog(),
  );

  // 发送压缩事件（包含 compaction block 信息）
  ctx.runtime.onEvent({
    type: 'context_compressed',
    data: {
      savedTokens: block.compactedTokenCount,
      strategy: 'compaction_block',
      newMessageCount: ctx.runtime.messages.length,
    },
  } as AgentEvent);

  logger.info(`[AgentLoop] CompactionBlock generated: ${block.compactedMessageCount} msgs compacted, saved ${block.compactedTokenCount} tokens`);

  if (options.emitCompacted) {
    const currentTokens = options.currentTokens ?? 0;
    ctx.runtime.onEvent({
      type: 'context_compacted',
      data: {
        tokensBefore: currentTokens,
        tokensAfter: Math.max(0, currentTokens - block.compactedTokenCount),
        messagesRemoved: block.compactedMessageCount,
        duration_ms: Date.now() - (options.compactionStartTime ?? Date.now()),
      },
    } as AgentEvent);
  }

  logCollector.agent('INFO', 'CompactionBlock generated', {
    compactedMessages: block.compactedMessageCount,
    savedTokens: block.compactedTokenCount,
    compactionCount: ctx.runtime.autoCompressor.getCompactionCount(),
  });
}

export function updateContextHealth(ctx: ContextAssemblyCtx): void {
  try {
    const contextHealthService = getContextHealthService();
    const model = ctx.runtime.modelConfig.model || DEFAULT_MODELS.chat;

    const messagesForEstimation = ctx.runtime.messages.map(msg => ({
      role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolResults: msg.toolResults?.map(tr => ({
        output: tr.output,
        error: tr.error,
      })),
    }));

    const health = contextHealthService.update(
      ctx.runtime.sessionId,
      messagesForEstimation,
      ctx.runtime.systemPrompt,
      model,
      undefined,
      estimateActiveToolDefinitionsTokens(),
      // GAP-023: 被预算丢弃的 prompt 块可见化到 context health 面板
      ctx.runtime.droppedPromptBlocks ? [...ctx.runtime.droppedPromptBlocks] : undefined,
    );

    // 更新压缩统计到健康状态
    const compressionStats = ctx.runtime.autoCompressor.getStats();
    if (compressionStats.compressionCount > 0 && health.compression) {
      health.compression.compressionCount = compressionStats.compressionCount;
      health.compression.totalSavedTokens = compressionStats.totalSavedTokens;
      health.compression.lastCompressionAt = compressionStats.lastCompressionAt;
    }
  } catch (error) {
    logger.error('[AgentLoop] Failed to update context health:', error);
  }
}

export async function checkAndAutoCompress(ctx: ContextAssemblyCtx): Promise<void> {
  try {
    const currentTokens = ctx.runtime.messages.reduce(
      (sum, msg) => sum + estimateTokens(msg.content || ''),
      0
    );

    const compressorConfig = ctx.runtime.autoCompressor.getConfig();
    const health = getContextHealthService().get(ctx.runtime.sessionId);
    const paths = resolveCheckpointStorePaths({
      sessionId: ctx.runtime.sessionId,
      workingDirectory: ctx.runtime.workingDirectory,
      rootDir: ctx.runtime.checkpointRootDir,
    });
    const existingCheckpoint = !ctx.runtime.agentId
      ? await readExistingCheckpointStore(paths)
      : null;
    const checkpointRebuildAvailable = Boolean(
      existingCheckpoint
      && validateCheckpointDocument(existingCheckpoint.checkpoint).activeIntentHasVerbatimQuote,
    );
    const checkpointWatermark = ctx.runtime.messages.at(-1)?.id;

    // P2-full/G11: 单一压力决策点 —— 绝对 token 阈值、百分比 warning、Pipeline 的
    // autocompact-needed 信号，三者统一在 ContextPressureController 里裁定，不再各自内联。
    // 注意 compressionEnabled 只 gate 百分比软触发；token 硬阈值和 pipeline 信号必须压。
    const decision = assessContextPressure({
      currentTokens,
      tokenThresholdHit: ctx.runtime.autoCompressor.shouldTriggerByTokens(currentTokens),
      usageRatio: health ? health.usagePercent / 100 : undefined,
      warningThreshold: compressorConfig.warningThreshold,
      pipelineAutocompactNeeded: ctx.runtime.pipelineAutocompactNeeded,
      checkpointRebuildAvailable,
      checkpointRebuildAlreadyInserted: checkpointWatermark !== undefined
        && ctx.runtime.checkpointRebuildLastWatermarkId === checkpointWatermark,
      isMainAgent: !ctx.runtime.agentId,
      compressionEnabled: compressorConfig.enabled,
    });
    // one-shot 信号：评估后立即清零，避免跨 turn 残留
    ctx.runtime.pipelineAutocompactNeeded = false;

    if (decision.action === 'none') return;

    logger.info(`[AgentLoop] Context pressure (${decision.trigger}): ${decision.reason} — triggering ${decision.action}`);

    // Emit context_compacting event (Claude Code style) — 现在所有触发路径统一发，
    // 不再只有 token-threshold 路径发。
    const compactionStartTime = Date.now();
    ctx.runtime.onEvent({
      type: 'context_compacting',
      data: {
        tokensBefore: currentTokens,
        messagesCount: ctx.runtime.messages.length,
      },
    } as AgentEvent);

    if (decision.action === 'checkpoint-rebuild') {
      getCheckpointWriterService().trigger({
        sessionId: ctx.runtime.sessionId,
        workingDirectory: ctx.runtime.workingDirectory,
        messages: ctx.runtime.messages,
        reason: 'pressure',
        rootDir: ctx.runtime.checkpointRootDir,
      });
      const boundary = await tryInsertCheckpointRebuildBoundary(ctx.runtime);
      if (boundary.inserted) {
        persistRuntimeState(ctx.runtime, { compressionState: true, persistentSystemContext: false });
        logger.info('[AgentLoop] Checkpoint rebuild boundary inserted before pure compaction', {
          sessionId: ctx.runtime.sessionId,
          compactedMessageCount: boundary.compactedMessageCount,
          boundaryMessageId: boundary.boundaryMessageId,
        });
        return;
      }
      logger.warn('[AgentLoop] Checkpoint rebuild boundary unavailable, falling back to summary compaction', {
        sessionId: ctx.runtime.sessionId,
        reason: boundary.reason,
      });
    }

    const preserveCount = compressorConfig.preserveRecentCount;
    const compactionResult = await compactMessagesWithSummary({
      sessionId: ctx.runtime.sessionId,
      source: 'auto_threshold',
      messages: ctx.runtime.messages,
      preserveRecentCount: preserveCount,
      systemPrompt: ctx.runtime.systemPrompt,
      modelConfig: ctx.runtime.modelConfig,
      hookManager: ctx.runtime.hookManager,
      usagePercent: health?.usagePercent,
    });

    if (compactionResult.success && compactionResult.block) {
      const { block } = compactionResult;
      ctx.runtime.autoCompressor.recordCompaction(block.compactedTokenCount, 'ai_summary');

      await commitCompactionBlock(ctx, block, preserveCount, {
        currentTokens,
        compactionStartTime,
        emitCompacted: true,
        survivorReason: `Compaction block inserted after ${decision.trigger} compaction`,
      });

      // 检查是否应该收尾（总预算超限）—— 同样统一到所有触发路径
      if (ctx.runtime.autoCompressor.shouldWrapUp()) {
        logger.warn('[AgentLoop] Total token budget exceeded, injecting wrap-up instruction');
        ctx.injectSystemMessage(
          '<wrap-up>\n' +
          '你已经使用了大量 token。请总结当前工作进展并收尾：\n' +
          '1. 列出已完成的任务\n' +
          '2. 列出未完成的任务及原因\n' +
          '3. 给出后续建议\n' +
          '</wrap-up>'
        );
      }
    }
  } catch (error) {
    logger.error('[AgentLoop] Auto compression failed:', error);
  }
}

// ContextAssembly - Context health tracking and hard-threshold compression.
import type { AgentEvent, Message } from '../../../../shared/contract';
import { DEFAULT_MODELS } from '../../../../shared/constants';
import { getContextHealthService } from '../../../context/contextHealthService';
import { CompressionState } from '../../../context/compressionState';
import { getContextEventLedger } from '../../../context/contextEventLedger';
import { estimateTokens } from '../../../context/tokenOptimizer';
import { logCollector } from '../../../mcp/logCollector.js';
import { fileReadTracker } from '../../../tools/fileReadTracker';
import { dataFingerprintStore } from '../../../tools/dataFingerprint';
import { getIncompleteTasks } from '../../../services/planning/taskStore';
import { getSessionTodos } from '../../../agent/todoParser';
import type { ContextAssemblyCtx } from '../contextAssembly';
import { cachedReaddirSync, logger } from '../contextAssembly';

export function updateContextHealth(ctx: ContextAssemblyCtx): void {
  try {
    const contextHealthService = getContextHealthService();
    const model = ctx.runtime.modelConfig.model || DEFAULT_MODELS.chat;

    const messagesForEstimation = ctx.runtime.messages.map(msg => ({
      role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
      content: msg.content,
      toolResults: msg.toolResults?.map(tr => ({
        output: tr.output,
        error: tr.error,
      })),
    }));

    const health = contextHealthService.update(
      ctx.runtime.sessionId,
      messagesForEstimation,
      ctx.runtime.systemPrompt,
      model
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
    // 计算当前 token 使用量
    const currentTokens = ctx.runtime.messages.reduce(
      (sum, msg) => sum + estimateTokens(msg.content || ''),
      0
    );

    // 检查绝对 token 阈值触发（Claude Code 风格）
    if (ctx.runtime.autoCompressor.shouldTriggerByTokens(currentTokens)) {
      logger.info(`[AgentLoop] Token threshold reached (${currentTokens}), triggering compaction`);

      // Emit context_compacting event (Claude Code style)
      const compactionStartTime = Date.now();
      ctx.runtime.onEvent({
        type: 'context_compacting',
        data: {
          tokensBefore: currentTokens,
          messagesCount: ctx.runtime.messages.length,
        },
      } as AgentEvent);

      const messagesForCompression = ctx.runtime.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        id: msg.id,
        timestamp: msg.timestamp,
        toolCallId: msg.toolResults?.[0]?.toolCallId,      // 保留 tool↔assistant 配对
        toolCallIds: msg.toolCalls?.map(tc => tc.id),       // 保留 assistant→tool 配对
      }));

      // 生成 CompactionBlock
      const compactionResult = await ctx.runtime.autoCompressor.compactToBlock(
        messagesForCompression,
        ctx.runtime.systemPrompt,
        ctx.runtime.hookManager
      );

      if (compactionResult) {
        const { block } = compactionResult;

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
        const compactionMessage: Message = {
          id: ctx.generateId(),
          role: 'system',
          content: `[Compaction] 已压缩 ${block.compactedMessageCount} 条消息，节省 ${block.compactedTokenCount} tokens\n\n${block.content}`,
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
          reason: 'Compaction block inserted after hard threshold compaction',
          timestamp: block.timestamp,
        }]);

        // Layer 2: 全量替换 — 删除被压缩的旧消息，只保留 compaction + 最近 N 条
        const preserveCount = ctx.runtime.autoCompressor.getConfig().preserveRecentCount;
        const boundary = ctx.runtime.messages.length - preserveCount;
        if (boundary > 0) {
          // 替换 messages[0..boundary) 为单条 compaction 消息
          ctx.runtime.messages.splice(0, boundary, compactionMessage);
          logger.info(`[AgentLoop] Layer 2: spliced ${boundary} old messages, kept ${preserveCount} recent + 1 compaction`);
        } else {
          // 消息太少，仅追加
          ctx.runtime.messages.push(compactionMessage);
        }
        ctx.recordContextEventsForMessage(compactionMessage);
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

        // Emit context_compacted event (Claude Code style)
        ctx.runtime.onEvent({
          type: 'context_compacted',
          data: {
            tokensBefore: currentTokens,
            tokensAfter: currentTokens - block.compactedTokenCount,
            messagesRemoved: block.compactedMessageCount,
            duration_ms: Date.now() - compactionStartTime,
          },
        } as AgentEvent);
        logCollector.agent('INFO', 'CompactionBlock generated', {
          compactedMessages: block.compactedMessageCount,
          savedTokens: block.compactedTokenCount,
          compactionCount: ctx.runtime.autoCompressor.getCompactionCount(),
        });

        // 检查是否应该收尾（总预算超限）
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

        return; // compaction 成功，跳过旧的压缩逻辑
      }
    }

    // 回退到原有的百分比阈值压缩
    const messagesForCompression = ctx.runtime.messages.map(msg => ({
      role: msg.role,
      content: msg.content,
      id: msg.id,
      timestamp: msg.timestamp,
      toolCallId: msg.toolResults?.[0]?.toolCallId,      // 保留 tool↔assistant 配对
      toolCallIds: msg.toolCalls?.map(tc => tc.id),       // 保留 assistant→tool 配对
    }));

    const result = await ctx.runtime.autoCompressor.checkAndCompress(
      ctx.runtime.sessionId,
      messagesForCompression,
      ctx.runtime.systemPrompt,
      ctx.runtime.modelConfig.model || DEFAULT_MODELS.chat,
      ctx.runtime.hookManager
    );

    if (result.compressed) {
      logger.info(`[AgentLoop] Auto compression: saved ${result.savedTokens} tokens using ${result.strategy}`);
      logCollector.agent('INFO', 'Auto context compression', {
        savedTokens: result.savedTokens,
        strategy: result.strategy,
        messageCount: result.messages.length,
      });

      // 发送压缩事件
      ctx.runtime.onEvent({
        type: 'context_compressed',
        data: {
          savedTokens: result.savedTokens,
          strategy: result.strategy,
          newMessageCount: result.messages.length,
        },
      } as AgentEvent);
    }
  } catch (error) {
    logger.error('[AgentLoop] Auto compression failed:', error);
  }
}

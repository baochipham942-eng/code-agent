// ============================================================================
// Auto Context Compressor - 自动上下文压缩服务
// ============================================================================
// 接近 token 上限时自动压缩历史消息，保持对话流畅
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { estimateTokens } from './tokenEstimator';
import {
  MessageHistoryCompressor,
  CompressedMessage,
} from './tokenOptimizer';
import {
  ContextHealthState,
  CompressionStats,
  getCompressionStatus,
} from '../../shared/types/contextHealth';
import { getContextHealthService } from './contextHealthService';
import { compactModelSummarize } from './compactModel';
import type { HookManager } from '../hooks/hookManager';
import type { Message, CompactionBlock } from '../../shared/types';
import { getDocumentContextService } from './documentContext';

const logger = createLogger('AutoCompressor');

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

export interface AutoCompressionConfig {
  /** 是否启用自动压缩 */
  enabled: boolean;
  /** 警告阈值 (0-1)，开始监控 */
  warningThreshold: number;
  /** 危急阈值 (0-1)，立即压缩 */
  criticalThreshold: number;
  /** 压缩目标使用率 (0-1) */
  targetUsage: number;
  /** 保留最近 N 条消息不压缩 */
  preserveRecentCount: number;
  /** 是否使用 AI 摘要 */
  useAISummary: boolean;
  /** AI 摘要阈值 (0-1)，仅在高使用率时使用 */
  aiSummaryThreshold: number;
  // ===== Claude Code 风格增强 =====
  /** 绝对 token 阈值触发压缩（优先于百分比） */
  triggerTokens?: number;           // 默认 100000
  /** 压缩后暂停，允许注入保留内容 */
  pauseAfterCompaction?: boolean;   // 默认 false
  /** 自定义摘要指令（覆盖默认 prompt） */
  instructions?: string;
  /** 总 token 预算控制（compaction 次数 × 阈值 ≥ 总预算时触发收尾） */
  totalTokenBudget?: number;        // 如 3000000
}

const DEFAULT_CONFIG: AutoCompressionConfig = {
  enabled: true,
  warningThreshold: 0.6,
  criticalThreshold: 0.85,
  targetUsage: 0.5,
  preserveRecentCount: 6,
  useAISummary: true,
  aiSummaryThreshold: 0.9,
  triggerTokens: 100000,
  pauseAfterCompaction: false,
};

// ----------------------------------------------------------------------------
// Compression Strategy
// ----------------------------------------------------------------------------

type CompressionStrategy = 'truncate' | 'code_extract' | 'ai_summary';

interface CompressionResult {
  compressed: boolean;
  messages: CompressedMessage[];
  savedTokens: number;
  strategy?: CompressionStrategy;
}

// ----------------------------------------------------------------------------
// Auto Context Compressor
// ----------------------------------------------------------------------------

export class AutoContextCompressor {
  private config: AutoCompressionConfig;
  private historyCompressor: MessageHistoryCompressor;
  private compressionHistory: Array<{
    timestamp: number;
    savedTokens: number;
    strategy: CompressionStrategy;
  }> = [];

  constructor(config: Partial<AutoCompressionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.historyCompressor = new MessageHistoryCompressor({
      preserveRecentCount: this.config.preserveRecentCount,
    });
  }

  /**
   * 检查并执行自动压缩
   *
   * @param sessionId - 会话 ID
   * @param messages - 当前消息历史
   * @param systemPrompt - 系统提示词
   * @param model - 模型名称
   * @param hookManager - 可选的 HookManager 实例，用于触发 PreCompact Hook
   * @returns 压缩结果
   */
  async checkAndCompress(
    sessionId: string,
    messages: CompressedMessage[],
    systemPrompt: string,
    model: string,
    hookManager?: HookManager
  ): Promise<CompressionResult> {
    if (!this.config.enabled) {
      return { compressed: false, messages, savedTokens: 0 };
    }

    const healthService = getContextHealthService();
    const health = healthService.get(sessionId);
    const usageRatio = health.usagePercent / 100;

    // 更新压缩状态
    const compressionStatus = getCompressionStatus(health.usagePercent);

    // 低于警告阈值，无需压缩
    if (usageRatio < this.config.warningThreshold) {
      return { compressed: false, messages, savedTokens: 0 };
    }

    logger.info(`[AutoCompressor] Usage at ${(usageRatio * 100).toFixed(1)}%, checking compression...`);

    // 选择压缩策略
    const strategy = this.selectStrategy(usageRatio);

    // 执行压缩
    const result = await this.applyStrategy(sessionId, strategy, messages, systemPrompt, health, hookManager);

    if (result.compressed) {
      // 记录压缩历史
      this.compressionHistory.push({
        timestamp: Date.now(),
        savedTokens: result.savedTokens,
        strategy,
      });

      // 更新健康状态中的压缩统计
      this.updateCompressionStats(sessionId, result.savedTokens);

      logger.info(
        `[AutoCompressor] Compressed using ${strategy}: saved ${result.savedTokens} tokens`
      );
    }

    return result;
  }

  /**
   * 根据使用率选择压缩策略
   */
  private selectStrategy(usageRatio: number): CompressionStrategy {
    // 高使用率时使用 AI 摘要（如果启用）
    if (this.config.useAISummary && usageRatio >= this.config.aiSummaryThreshold) {
      return 'ai_summary';
    }

    // 中高使用率时提取代码块
    if (usageRatio >= this.config.criticalThreshold) {
      return 'code_extract';
    }

    // 默认截断
    return 'truncate';
  }

  /**
   * 应用压缩策略
   */
  private async applyStrategy(
    sessionId: string,
    strategy: CompressionStrategy,
    messages: CompressedMessage[],
    systemPrompt: string,
    health: ContextHealthState,
    hookManager?: HookManager
  ): Promise<CompressionResult> {
    // 计算目标 token 数
    const targetTokens = Math.floor(health.maxTokens * this.config.targetUsage);

    // 调用 PreCompact Hook，提取关键信息
    let preservedContext: string | undefined;
    if (hookManager) {
      try {
        const hookResult = await hookManager.triggerPreCompact(
          sessionId,
          messages as unknown as Message[],
          health.currentTokens,
          targetTokens
        );
        preservedContext = hookResult.preservedContext;

        if (preservedContext) {
          logger.info(`[AutoCompressor] PreCompact hook extracted ${estimateTokens(preservedContext)} tokens of preserved context`);
        }
      } catch (error) {
        logger.warn('[AutoCompressor] PreCompact hook failed, continuing without preserved context:', error);
      }
    }

    switch (strategy) {
      case 'ai_summary':
        return this.applyAISummary(messages, systemPrompt, preservedContext);
      case 'code_extract':
        return this.applyCodeExtract(messages, preservedContext);
      case 'truncate':
      default:
        return this.applyTruncate(messages, preservedContext);
    }
  }

  /**
   * 截断压缩策略
   */
  private applyTruncate(
    messages: CompressedMessage[],
    preservedContext?: string
  ): CompressionResult {
    const result = this.historyCompressor.compress(messages);

    // 如果有保留的上下文，注入到消息列表开头
    if (preservedContext && result.wasCompressed) {
      const contextMessage: CompressedMessage = {
        role: 'system',
        content: preservedContext,
        compressed: true,
      };
      return {
        compressed: true,
        messages: [contextMessage, ...result.messages],
        savedTokens: result.stats.savedTokens - estimateTokens(preservedContext),
        strategy: 'truncate',
      };
    }

    return {
      compressed: result.wasCompressed,
      messages: result.messages,
      savedTokens: result.stats.savedTokens,
      strategy: 'truncate',
    };
  }

  /**
   * 代码提取压缩策略
   * 保留代码块，压缩叙述文本
   */
  private applyCodeExtract(
    messages: CompressedMessage[],
    preservedContext?: string
  ): CompressionResult {
    const preserveCount = this.config.preserveRecentCount;
    const recentMessages = messages.slice(-preserveCount);
    const olderMessages = messages.slice(0, -preserveCount);

    if (olderMessages.length === 0) {
      return { compressed: false, messages, savedTokens: 0 };
    }

    let savedTokens = 0;
    const compressedOlder: CompressedMessage[] = [];

    // 如果有保留的上下文，作为第一条消息
    if (preservedContext) {
      compressedOlder.push({
        role: 'system',
        content: preservedContext,
        compressed: true,
      });
    }

    for (const msg of olderMessages) {
      if (msg.role === 'user') {
        compressedOlder.push(msg);
        continue;
      }

      const originalTokens = estimateTokens(msg.content);
      const compressed = this.extractCodeBlocks(msg.content);
      const newTokens = estimateTokens(compressed);

      if (newTokens < originalTokens) {
        compressedOlder.push({
          ...msg,
          content: compressed,
          compressed: true,
        });
        savedTokens += originalTokens - newTokens;
      } else {
        compressedOlder.push(msg);
      }
    }

    // 扣除保留上下文的 token 数
    if (preservedContext) {
      savedTokens -= estimateTokens(preservedContext);
    }

    return {
      compressed: savedTokens > 0 || !!preservedContext,
      messages: [...compressedOlder, ...recentMessages],
      savedTokens: Math.max(0, savedTokens),
      strategy: 'code_extract',
    };
  }

  /**
   * 从内容中提取代码块
   */
  private extractCodeBlocks(content: string): string {
    const codeBlockRegex = /```[\s\S]*?```/g;
    const codeBlocks = content.match(codeBlockRegex) || [];

    if (codeBlocks.length === 0) {
      // 没有代码块，返回截断的内容
      const lines = content.split('\n');
      if (lines.length > 10) {
        return lines.slice(0, 5).join('\n') + '\n...[truncated]...\n' + lines.slice(-3).join('\n');
      }
      return content;
    }

    // 保留代码块，添加简短摘要
    const summary = content
      .replace(codeBlockRegex, '')
      .split('\n')
      .filter(line => line.trim())
      .slice(0, 3)
      .join('\n');

    return `${summary}\n\n[Code preserved]\n${codeBlocks.join('\n\n')}`;
  }

  /**
   * E5: 文档感知压缩 - 使用 DocumentContextService 按 importance 保留重要内容
   *
   * @param content - 文档内容
   * @param filePath - 文件路径（用于判断文档类型）
   * @param tokenBudget - Token 预算
   * @returns 压缩后的内容，如果无法解析则返回 null
   */
  async compressDocumentContent(
    content: string,
    filePath: string,
    tokenBudget: number
  ): Promise<string | null> {
    try {
      const docService = getDocumentContextService();
      if (!docService.canParse(filePath)) {
        return null;
      }
      const parsed = await docService.parse(content, filePath);
      if (!parsed) {
        return null;
      }
      return parsed.toCompressedString(tokenBudget);
    } catch (error) {
      logger.debug('Document-aware compression failed:', error);
      return null;
    }
  }

  /**
   * AI 摘要压缩策略
   */
  private async applyAISummary(
    messages: CompressedMessage[],
    systemPrompt: string,
    preservedContext?: string
  ): Promise<CompressionResult> {
    const preserveCount = this.config.preserveRecentCount;
    const recentMessages = messages.slice(-preserveCount);
    const olderMessages = messages.slice(0, -preserveCount);

    if (olderMessages.length < 4) {
      // 消息太少，使用截断策略
      return this.applyTruncate(messages, preservedContext);
    }

    try {
      // 构建需要摘要的内容
      const contentToSummarize = olderMessages
        .map(msg => `[${msg.role}]: ${msg.content}`)
        .join('\n\n---\n\n');

      const originalTokens = estimateTokens(contentToSummarize);

      // 使用轻量级模型生成摘要
      const summaryPrompt = `请将以下对话历史压缩为简洁的摘要，保留关键信息：
- 用户的主要需求和问题
- 重要的代码片段（保留完整）
- 关键的决策和结论
- 待解决的问题

对话历史：
${contentToSummarize}

请生成一个简洁但信息完整的摘要（目标 500 字以内）：`;

      const summary = await compactModelSummarize(summaryPrompt, 800);
      const summaryTokens = estimateTokens(summary);

      if (summaryTokens >= originalTokens) {
        // 摘要没有节省空间，回退到截断
        logger.warn('[AutoCompressor] AI summary did not reduce tokens, falling back to truncate');
        return this.applyTruncate(messages, preservedContext);
      }

      // 创建摘要消息，包含保留的上下文
      const summaryContent = preservedContext
        ? `${preservedContext}\n\n[对话历史摘要]\n${summary}`
        : `[对话历史摘要]\n${summary}`;

      const summaryMessage: CompressedMessage = {
        role: 'system',
        content: summaryContent,
        compressed: true,
      };

      // 计算实际节省的 token 数（扣除保留上下文的开销）
      const preservedTokens = preservedContext ? estimateTokens(preservedContext) : 0;
      const actualSavedTokens = originalTokens - summaryTokens - preservedTokens;

      return {
        compressed: true,
        messages: [summaryMessage, ...recentMessages],
        savedTokens: Math.max(0, actualSavedTokens),
        strategy: 'ai_summary',
      };
    } catch (error) {
      logger.error('[AutoCompressor] AI summary failed, falling back to truncate:', error);
      return this.applyTruncate(messages, preservedContext);
    }
  }

  /**
   * 更新压缩统计到健康服务
   */
  private updateCompressionStats(sessionId: string, savedTokens: number): void {
    const stats = this.getStats();
    const healthService = getContextHealthService();
    const health = healthService.get(sessionId);

    // 更新压缩统计
    const compressionStats: CompressionStats = {
      status: getCompressionStatus(health.usagePercent),
      lastCompressionAt: Date.now(),
      compressionCount: stats.compressionCount,
      totalSavedTokens: stats.totalSavedTokens,
    };

    // 更新健康状态
    const updatedHealth: ContextHealthState = {
      ...health,
      compression: compressionStats,
    };

    // 由于 ContextHealthService 没有直接 set 方法，我们通过 update 来触发
    // 这里只是记录，实际更新会在下次 update 时同步
  }

  /**
   * 获取压缩统计
   */
  getStats(): {
    compressionCount: number;
    totalSavedTokens: number;
    lastCompressionAt?: number;
    recentStrategies: CompressionStrategy[];
  } {
    const stats = this.historyCompressor.getStats();
    return {
      compressionCount: stats.compressionCount,
      totalSavedTokens: stats.totalSavedTokens,
      lastCompressionAt: stats.lastCompressionTime || undefined,
      recentStrategies: this.compressionHistory.slice(-5).map(h => h.strategy),
    };
  }

  /**
   * 重置统计
   */
  reset(): void {
    this.historyCompressor.reset();
    this.compressionHistory = [];
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<AutoCompressionConfig>): void {
    this.config = { ...this.config, ...config };
    this.historyCompressor = new MessageHistoryCompressor({
      preserveRecentCount: this.config.preserveRecentCount,
    });
  }

  /**
   * 激进截断：保留最近 20 条完整，20-50 条只保留摘要，tool_result 超 500 tokens 截断到 300
   */
  aggressiveTruncate(messages: CompressedMessage[]): CompressedMessage[] {
    const len = messages.length;
    if (len <= 20) return messages;

    const result: CompressedMessage[] = [];

    for (let i = 0; i < len; i++) {
      const distFromEnd = len - 1 - i;
      const msg = messages[i];

      if (distFromEnd < 20) {
        // Last 20: keep uncompressed
        result.push(msg);
      } else if (distFromEnd < 50) {
        // Positions 20-50 from end: keep role + first 200 chars
        result.push({
          ...msg,
          content: msg.content.substring(0, 200) + (msg.content.length > 200 ? '...[truncated]' : ''),
          compressed: true,
        });
      } else {
        // Older than 50 from end: check tool_result token budget
        const tokens = estimateTokens(msg.content);
        if (msg.role === 'tool' && tokens > 500) {
          // Truncate to ~300 tokens (roughly 1200 chars)
          const lines = msg.content.split('\n');
          let accumulated = 0;
          const kept: string[] = [];
          for (const line of lines) {
            const lineTokens = estimateTokens(line);
            if (accumulated + lineTokens > 300) {
              kept.push('...[truncated]');
              break;
            }
            kept.push(line);
            accumulated += lineTokens;
          }
          result.push({
            ...msg,
            content: kept.join('\n'),
            compressed: true,
          });
        } else {
          result.push({
            ...msg,
            content: msg.content.substring(0, 200) + (msg.content.length > 200 ? '...[truncated]' : ''),
            compressed: true,
          });
        }
      }
    }

    return result;
  }

  // ========================================================================
  // Claude Code 风格增强方法
  // ========================================================================

  /**
   * 检查是否达到绝对 token 阈值
   * 返回 true 表示应该触发 compaction
   */
  shouldTriggerByTokens(currentTokens: number): boolean {
    if (!this.config.triggerTokens) return false;
    return currentTokens >= this.config.triggerTokens;
  }

  /**
   * 生成 CompactionBlock（不直接替换消息，返回摘要块）
   *
   * 与 checkAndCompress 不同，此方法：
   * 1. 返回 CompactionBlock 而非修改消息列表
   * 2. 保留在消息历史中（可审计）
   * 3. 支持自定义摘要指令
   */
  async compactToBlock(
    messages: CompressedMessage[],
    systemPrompt: string,
    hookManager?: HookManager
  ): Promise<{ block: CompactionBlock; preservedContext?: string } | null> {
    const preserveCount = this.config.preserveRecentCount;
    const olderMessages = messages.slice(0, -preserveCount);

    if (olderMessages.length < 4) {
      return null;
    }

    // 调用 PreCompact Hook 获取保留内容
    let preservedContext: string | undefined;
    if (hookManager && this.config.pauseAfterCompaction) {
      try {
        const hookResult = await hookManager.triggerPreCompact(
          'compaction',
          olderMessages as unknown as Message[],
          olderMessages.length,
          preserveCount
        );
        preservedContext = hookResult.preservedContext;
      } catch (error) {
        logger.warn('[AutoCompressor] PreCompact hook failed:', error);
      }
    }

    // 构建摘要内容
    const contentToSummarize = olderMessages
      .map(msg => `[${msg.role}]: ${msg.content}`)
      .join('\n\n---\n\n');

    const originalTokens = estimateTokens(contentToSummarize);

    try {
      // 使用自定义指令或 Claude 风格默认 prompt
      const instructions = this.config.instructions || this.getClaudeStyleSummaryPrompt();

      const summaryPrompt = `${instructions}\n\n对话历史：\n${contentToSummarize}\n\n请生成摘要：`;
      const summary = await compactModelSummarize(summaryPrompt, 1000);
      const summaryTokens = estimateTokens(summary);

      if (summaryTokens >= originalTokens) {
        logger.warn('[AutoCompressor] Compaction did not reduce tokens');
        return null;
      }

      const block: CompactionBlock = {
        type: 'compaction',
        content: preservedContext
          ? `${preservedContext}\n\n---\n\n${summary}`
          : summary,
        timestamp: Date.now(),
        compactedMessageCount: olderMessages.length,
        compactedTokenCount: originalTokens - summaryTokens,
      };

      // 记录压缩历史
      this.compressionHistory.push({
        timestamp: Date.now(),
        savedTokens: originalTokens - summaryTokens,
        strategy: 'ai_summary',
      });

      logger.info(`[AutoCompressor] CompactionBlock generated: ${olderMessages.length} msgs, saved ${originalTokens - summaryTokens} tokens`);

      return { block, preservedContext };
    } catch (error) {
      logger.error('[AutoCompressor] compactToBlock failed:', error);
      return null;
    }
  }

  /**
   * 基于 compaction 次数判断是否应收尾
   * 当 compactionCount × triggerTokens ≥ totalTokenBudget 时返回 true
   */
  shouldWrapUp(): boolean {
    if (!this.config.totalTokenBudget || !this.config.triggerTokens) {
      return false;
    }
    const compactionCount = this.getCompactionCount();
    const estimatedTotalTokens = compactionCount * this.config.triggerTokens;
    return estimatedTotalTokens >= this.config.totalTokenBudget;
  }

  /**
   * 返回累计压缩次数
   */
  getCompactionCount(): number {
    return this.compressionHistory.length;
  }

  /**
   * Claude 风格摘要 prompt：聚焦状态、下一步、关键决策、学到的教训
   */
  private getClaudeStyleSummaryPrompt(): string {
    return `请将以下对话历史压缩为一份结构化的工作状态摘要。

**摘要必须包含以下部分：**
1. **当前状态**：任务进展到哪一步了？完成了什么？
2. **关键决策**：做了哪些重要决策？为什么？
3. **代码变更**：修改了哪些文件？关键代码片段（保留完整）
4. **待解决问题**：还有什么没做完？遇到了什么障碍？
5. **学到的教训**：发现了什么重要信息？哪些方法有效/无效？
6. **下一步**：接下来应该做什么？

**要求**：
- 保留所有代码片段和文件路径
- 保留错误信息和调试线索
- 使用简洁的条目式格式
- 目标 800 字以内`;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let autoCompressorInstance: AutoContextCompressor | null = null;

export function getAutoCompressor(): AutoContextCompressor {
  if (!autoCompressorInstance) {
    autoCompressorInstance = new AutoContextCompressor();
  }
  return autoCompressorInstance;
}

export function initAutoCompressor(config?: Partial<AutoCompressionConfig>): AutoContextCompressor {
  autoCompressorInstance = new AutoContextCompressor(config);
  return autoCompressorInstance;
}

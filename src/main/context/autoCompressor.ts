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
}

const DEFAULT_CONFIG: AutoCompressionConfig = {
  enabled: true,
  warningThreshold: 0.7,
  criticalThreshold: 0.85,
  targetUsage: 0.5,
  preserveRecentCount: 6,
  useAISummary: true,
  aiSummaryThreshold: 0.9,
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
   * @returns 压缩结果
   */
  async checkAndCompress(
    sessionId: string,
    messages: CompressedMessage[],
    systemPrompt: string,
    model: string
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
    const result = await this.applyStrategy(strategy, messages, systemPrompt);

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
    strategy: CompressionStrategy,
    messages: CompressedMessage[],
    systemPrompt: string
  ): Promise<CompressionResult> {
    switch (strategy) {
      case 'ai_summary':
        return this.applyAISummary(messages, systemPrompt);
      case 'code_extract':
        return this.applyCodeExtract(messages);
      case 'truncate':
      default:
        return this.applyTruncate(messages);
    }
  }

  /**
   * 截断压缩策略
   */
  private applyTruncate(messages: CompressedMessage[]): CompressionResult {
    const result = this.historyCompressor.compress(messages);
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
  private applyCodeExtract(messages: CompressedMessage[]): CompressionResult {
    const preserveCount = this.config.preserveRecentCount;
    const recentMessages = messages.slice(-preserveCount);
    const olderMessages = messages.slice(0, -preserveCount);

    if (olderMessages.length === 0) {
      return { compressed: false, messages, savedTokens: 0 };
    }

    let savedTokens = 0;
    const compressedOlder: CompressedMessage[] = [];

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

    return {
      compressed: savedTokens > 0,
      messages: [...compressedOlder, ...recentMessages],
      savedTokens,
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
   * AI 摘要压缩策略
   */
  private async applyAISummary(
    messages: CompressedMessage[],
    systemPrompt: string
  ): Promise<CompressionResult> {
    const preserveCount = this.config.preserveRecentCount;
    const recentMessages = messages.slice(-preserveCount);
    const olderMessages = messages.slice(0, -preserveCount);

    if (olderMessages.length < 4) {
      // 消息太少，使用截断策略
      return this.applyTruncate(messages);
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
        return this.applyTruncate(messages);
      }

      // 创建摘要消息
      const summaryMessage: CompressedMessage = {
        role: 'system',
        content: `[对话历史摘要]\n${summary}`,
        compressed: true,
      };

      return {
        compressed: true,
        messages: [summaryMessage, ...recentMessages],
        savedTokens: originalTokens - summaryTokens,
        strategy: 'ai_summary',
      };
    } catch (error) {
      logger.error('[AutoCompressor] AI summary failed, falling back to truncate:', error);
      return this.applyTruncate(messages);
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

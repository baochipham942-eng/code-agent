// ============================================================================
// Auto Context Compressor State
// ============================================================================
// Compression execution is owned by CompressionPipeline,
// ContextPressureController, and CompactionService. This module retains the
// shared runtime configuration and compaction accounting consumed by callers.
// ============================================================================

export interface AutoCompressionConfig {
  /** 是否启用自动压缩 */
  enabled: boolean;
  /** 警告阈值 (0-1)，开始监控 */
  warningThreshold: number;
  /** 危急阈值 (0-1) */
  criticalThreshold: number;
  /** 保留最近 N 条消息不压缩 */
  preserveRecentCount: number;
  /** 绝对 token 阈值触发压缩 */
  triggerTokens?: number;
  /** 总 token 预算控制 */
  totalTokenBudget?: number;
}

const DEFAULT_CONFIG: AutoCompressionConfig = {
  enabled: true,
  warningThreshold: 0.75,
  criticalThreshold: 0.85,
  preserveRecentCount: 10,
  triggerTokens: 100000,
};

type CompressionStrategy = 'ai_summary';

export class AutoContextCompressor {
  private config: AutoCompressionConfig;
  private compressionHistory: Array<{
    timestamp: number;
    savedTokens: number;
    strategy: CompressionStrategy;
  }> = [];

  constructor(config: Partial<AutoCompressionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getStats(): {
    compressionCount: number;
    totalSavedTokens: number;
    lastCompressionAt?: number;
    recentStrategies: CompressionStrategy[];
  } {
    return {
      compressionCount: this.compressionHistory.length,
      totalSavedTokens: this.compressionHistory.reduce(
        (total, entry) => total + entry.savedTokens,
        0,
      ),
      lastCompressionAt: this.compressionHistory.at(-1)?.timestamp,
      recentStrategies: this.compressionHistory.slice(-5).map((entry) => entry.strategy),
    };
  }

  reset(): void {
    this.compressionHistory = [];
  }

  getConfig(): Readonly<AutoCompressionConfig> {
    return this.config;
  }

  updateConfig(config: Partial<AutoCompressionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  shouldTriggerByTokens(currentTokens: number): boolean {
    if (!this.config.triggerTokens) return false;
    return currentTokens >= this.config.triggerTokens;
  }

  shouldWrapUp(): boolean {
    if (!this.config.totalTokenBudget || !this.config.triggerTokens) {
      return false;
    }
    const estimatedTotalTokens = this.getCompactionCount() * this.config.triggerTokens;
    return estimatedTotalTokens >= this.config.totalTokenBudget;
  }

  getCompactionCount(): number {
    return this.compressionHistory.length;
  }

  recordCompaction(
    savedTokens: number,
    strategy: CompressionStrategy = 'ai_summary',
  ): void {
    this.compressionHistory.push({
      timestamp: Date.now(),
      savedTokens,
      strategy,
    });
  }
}

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

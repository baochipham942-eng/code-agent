// ============================================================================
// Auto Context Compressor State
// ============================================================================
// Compression execution is owned by CompressionPipeline,
// ContextPressureController, and CompactionService. This module retains the
// shared runtime configuration and compaction accounting consumed by callers.
// ============================================================================

import { resolveTriggerTokens } from './triggerTokens';

export interface AutoCompressionConfig {
  /** 是否启用自动压缩 */
  enabled: boolean;
  /** Soft gate (0-1). Gates usage-percent triggers only; not the forced path. */
  warningThreshold: number;
  /**
   * Settings "Clean at" ratio. Persisted for the slider; no host decision reads it.
   * Forced occupancy lives in PIPELINE_AUTOCOMPACT_OCCUPANCY.
   */
  criticalThreshold: number;
  /** 保留最近 N 条消息不压缩 */
  preserveRecentCount: number;
  /** Explicit absolute override. Absent → derive from the model window. */
  triggerTokens?: number;
  /** 总 token 预算控制 */
  totalTokenBudget?: number;
}

const DEFAULT_CONFIG: AutoCompressionConfig = {
  enabled: true,
  warningThreshold: 0.75,
  criticalThreshold: 0.85,
  preserveRecentCount: 10,
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

  private resolvedTrigger(contextWindow?: number): number | undefined {
    const explicit = this.config.triggerTokens;
    if (typeof explicit === 'number' && explicit > 0) return explicit;
    if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
      return undefined;
    }
    const derived = resolveTriggerTokens(contextWindow);
    return derived > 0 ? derived : undefined;
  }

  shouldTriggerByTokens(currentTokens: number, contextWindow?: number): boolean {
    const trigger = this.resolvedTrigger(contextWindow);
    if (trigger === undefined) return false;
    return currentTokens >= trigger;
  }

  shouldWrapUp(contextWindow?: number): boolean {
    const trigger = this.resolvedTrigger(contextWindow);
    if (!this.config.totalTokenBudget || trigger === undefined) return false;
    return this.getCompactionCount() * trigger >= this.config.totalTokenBudget;
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

// ============================================================================
// Budget Service - Cost budget tracking and alert system
// Implements 3-tier warning: 70% silent log, 85-90% user alert, 100% block
// ============================================================================

import { createLogger } from '../infra/logger';
import { MODEL_PRICING_PER_1M } from '../../../shared/constants';

const logger = createLogger('BudgetService');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Budget alert level thresholds
 */
export enum BudgetAlertLevel {
  NONE = 'none',        // Under 70%
  SILENT = 'silent',    // 70% - Silent log
  WARNING = 'warning',  // 85-90% - User alert
  BLOCKED = 'blocked',  // 100% - Execution blocked
}

/**
 * Budget configuration
 */
export interface BudgetConfig {
  enabled: boolean;
  /** Maximum budget in USD (default: 10.0) */
  maxBudget: number;
  /** Silent log threshold (default: 0.7 = 70%) */
  silentThreshold: number;
  /** Warning threshold (default: 0.85 = 85%) */
  warningThreshold: number;
  /** Block threshold (default: 1.0 = 100%) */
  blockThreshold: number;
  /** Reset period in hours (default: 24) */
  resetPeriodHours: number;
}

/**
 * Budget status returned from checks
 */
export interface BudgetStatus {
  currentCost: number;
  maxBudget: number;
  usagePercentage: number;
  alertLevel: BudgetAlertLevel;
  remaining: number;
  resetTime?: Date;
  message?: string;
}

/**
 * Token usage record for cost calculation
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: string;
  timestamp: number;
}

// Pricing sourced from shared constants (per 1M tokens, USD)

// ----------------------------------------------------------------------------
// BudgetService
// ----------------------------------------------------------------------------

/**
 * BudgetService - Tracks token/cost usage and implements tiered alerts
 *
 * Alert Levels:
 * - 70%: Silent log (no user notification)
 * - 85-90%: User warning (suggest reducing scope or increasing budget)
 * - 100%: Block execution
 *
 * @example
 * ```typescript
 * const budgetService = getBudgetService();
 *
 * // Check before execution
 * const status = budgetService.checkBudget();
 * if (status.alertLevel === BudgetAlertLevel.BLOCKED) {
 *   throw new Error('Budget exceeded');
 * }
 *
 * // Record usage after API call
 * budgetService.recordUsage({
 *   inputTokens: 1000,
 *   outputTokens: 500,
 *   model: 'deepseek-chat',
 *   provider: 'deepseek',
 *   timestamp: Date.now(),
 * });
 * ```
 */
export class BudgetService {
  private config: BudgetConfig;
  private usageHistory: TokenUsage[] = [];
  private periodStartTime: number;
  private silentLogEmitted: boolean = false;
  // 告警转换去重：每个周期内 warning/blocked 各只向 UI 推一次，避免每次 recordUsage 刷屏
  private warningEmitted: boolean = false;
  private blockedEmitted: boolean = false;
  private alertListener: ((status: BudgetStatus) => void) | null = null;

  constructor(config?: Partial<BudgetConfig>) {
    this.config = {
      enabled: config?.enabled ?? true,
      maxBudget: config?.maxBudget ?? 10.0,
      silentThreshold: config?.silentThreshold ?? 0.7,
      warningThreshold: config?.warningThreshold ?? 0.85,
      blockThreshold: config?.blockThreshold ?? 1.0,
      resetPeriodHours: config?.resetPeriodHours ?? 24,
    };
    this.periodStartTime = Date.now();
  }

  // --------------------------------------------------------------------------
  // Configuration
  // --------------------------------------------------------------------------

  /**
   * Update budget configuration
   */
  updateConfig(config: Partial<BudgetConfig>): void {
    const prev = this.config;
    this.config = { ...this.config, ...config };
    // Codex audit F2：阈值/上限/开关变了才重新武装告警去重标志，让"85% 告警过 →
    // 提阈值到 95% → 再越 95%"能重新告警。
    // Codex audit R2 回归修复：只在告警边界字段**实际变化**时 re-arm，否则启动 hydrate /
    // 原样保存 / no-op payload 这类 benign 重载会在已告警态下重复弹同一告警（spam）。
    const boundaryChanged =
      prev.enabled !== this.config.enabled
      || prev.maxBudget !== this.config.maxBudget
      || prev.warningThreshold !== this.config.warningThreshold
      || prev.blockThreshold !== this.config.blockThreshold;
    if (boundaryChanged) {
      this.warningEmitted = false;
      this.blockedEmitted = false;
    }
    logger.info('Budget config updated:', {
      maxBudget: this.config.maxBudget,
      enabled: this.config.enabled,
      boundaryChanged,
    });
  }

  /**
   * Get current budget configuration
   */
  getConfig(): BudgetConfig {
    return { ...this.config };
  }

  /**
   * Enable or disable budget tracking
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    logger.info(`Budget tracking ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Set maximum budget in USD
   */
  setMaxBudget(budget: number): void {
    if (budget < 0) {
      throw new Error('Budget must be non-negative');
    }
    this.config.maxBudget = budget;
    logger.info(`Max budget set to $${budget.toFixed(2)}`);
  }

  // --------------------------------------------------------------------------
  // Usage Tracking
  // --------------------------------------------------------------------------

  /**
   * Record token usage from an API call
   */
  recordUsage(usage: TokenUsage): void {
    if (!this.config.enabled) return;

    // Check if period needs reset
    this.checkPeriodReset();

    this.usageHistory.push(usage);

    const cost = this.calculateCost(usage);
    logger.debug(`Token usage recorded: ${usage.inputTokens} in / ${usage.outputTokens} out = $${cost.toFixed(4)}`);

    this.maybeEmitAlert();
  }

  /**
   * 注册告警监听器（启动期注入，负责把告警广播到 renderer toast）。
   */
  setAlertListener(listener: ((status: BudgetStatus) => void) | null): void {
    this.alertListener = listener;
  }

  /**
   * 记账后若跨入 warning/blocked，向监听器推一次（每周期每级别一次）。
   */
  private maybeEmitAlert(): void {
    if (!this.alertListener) return;
    const status = this.checkBudget();
    if (status.alertLevel === BudgetAlertLevel.BLOCKED && !this.blockedEmitted) {
      this.blockedEmitted = true;
      // Codex audit F1：用量一跃跨过 warning 直接到 blocked 时，warning 视作已消费，
      // 标志置位保持状态一致（blocked 比 warning 更紧急，不再补发 warning）。
      this.warningEmitted = true;
      this.alertListener(status);
    } else if (status.alertLevel === BudgetAlertLevel.WARNING && !this.warningEmitted) {
      this.warningEmitted = true;
      this.alertListener(status);
    }
  }

  /**
   * Calculate cost for a single usage record
   */
  private calculateCost(usage: TokenUsage): number {
    const pricing = this.getModelPricing(usage.model);
    const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
    const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
    return inputCost + outputCost;
  }

  /**
   * Get pricing for a model
   */
  private getModelPricing(model: string): { input: number; output: number } {
    // Try exact match
    if (MODEL_PRICING_PER_1M[model]) {
      return MODEL_PRICING_PER_1M[model];
    }

    // Try prefix match (e.g., 'gpt-4o-2024-08-06' -> 'gpt-4o')
    for (const key of Object.keys(MODEL_PRICING_PER_1M)) {
      if (model.startsWith(key)) {
        return MODEL_PRICING_PER_1M[key];
      }
    }

    // Fallback to default
    return MODEL_PRICING_PER_1M['default'];
  }

  /**
   * Get total cost for current period
   */
  getCurrentCost(): number {
    this.checkPeriodReset();
    return this.usageHistory.reduce((sum, usage) => sum + this.calculateCost(usage), 0);
  }

  /**
   * Get usage history for current period
   */
  getUsageHistory(): TokenUsage[] {
    this.checkPeriodReset();
    return [...this.usageHistory];
  }

  // --------------------------------------------------------------------------
  // Budget Checks
  // --------------------------------------------------------------------------

  /**
   * Check current budget status and alert level
   * This should be called before executing expensive operations
   */
  checkBudget(): BudgetStatus {
    if (!this.config.enabled) {
      return {
        currentCost: 0,
        maxBudget: this.config.maxBudget,
        usagePercentage: 0,
        alertLevel: BudgetAlertLevel.NONE,
        remaining: this.config.maxBudget,
      };
    }

    this.checkPeriodReset();

    const currentCost = this.getCurrentCost();
    const usagePercentage = this.config.maxBudget > 0
      ? currentCost / this.config.maxBudget
      : 0;
    const remaining = Math.max(0, this.config.maxBudget - currentCost);
    const resetTime = new Date(this.periodStartTime + this.config.resetPeriodHours * 60 * 60 * 1000);

    const alertLevel = this.determineAlertLevel(usagePercentage);
    const message = this.generateAlertMessage(alertLevel, usagePercentage, remaining);

    // Emit silent log at 70% (only once per period)
    if (alertLevel === BudgetAlertLevel.SILENT && !this.silentLogEmitted) {
      logger.warn(`Budget 70% threshold reached: $${currentCost.toFixed(2)} / $${this.config.maxBudget.toFixed(2)}`);
      this.silentLogEmitted = true;
    }

    return {
      currentCost,
      maxBudget: this.config.maxBudget,
      usagePercentage,
      alertLevel,
      remaining,
      resetTime,
      message,
    };
  }

  /**
   * Check if execution should be blocked due to budget
   */
  shouldBlock(): boolean {
    const status = this.checkBudget();
    return status.alertLevel === BudgetAlertLevel.BLOCKED;
  }

  /**
   * Check if a warning should be shown to user
   */
  shouldWarn(): boolean {
    const status = this.checkBudget();
    return status.alertLevel === BudgetAlertLevel.WARNING;
  }

  /**
   * Determine alert level based on usage percentage
   */
  private determineAlertLevel(usagePercentage: number): BudgetAlertLevel {
    if (usagePercentage >= this.config.blockThreshold) {
      return BudgetAlertLevel.BLOCKED;
    }
    if (usagePercentage >= this.config.warningThreshold) {
      return BudgetAlertLevel.WARNING;
    }
    if (usagePercentage >= this.config.silentThreshold) {
      return BudgetAlertLevel.SILENT;
    }
    return BudgetAlertLevel.NONE;
  }

  /**
   * Generate user-facing alert message
   */
  private generateAlertMessage(
    level: BudgetAlertLevel,
    usagePercentage: number,
    remaining: number
  ): string | undefined {
    const percentStr = (usagePercentage * 100).toFixed(0);
    const remainingStr = remaining.toFixed(2);

    switch (level) {
      case BudgetAlertLevel.WARNING:
        return `Budget ${percentStr}% used. Remaining: $${remainingStr}. Consider reducing task scope or increasing budget.`;
      case BudgetAlertLevel.BLOCKED:
        return `Budget exhausted (${percentStr}%). Execution blocked. Please increase budget or wait for reset.`;
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------------------
  // Period Management
  // --------------------------------------------------------------------------

  /**
   * Check if period needs reset and reset if necessary
   */
  private checkPeriodReset(): void {
    const now = Date.now();
    const periodMs = this.config.resetPeriodHours * 60 * 60 * 1000;

    if (now - this.periodStartTime >= periodMs) {
      this.resetPeriod();
    }
  }

  /**
   * Reset the current budget period
   */
  resetPeriod(): void {
    logger.info('Budget period reset');
    this.usageHistory = [];
    this.periodStartTime = Date.now();
    this.silentLogEmitted = false;
    this.warningEmitted = false;
    this.blockedEmitted = false;
  }

  /**
   * Manually reset budget (for user override)
   */
  manualReset(): void {
    logger.info('Budget manually reset by user');
    this.resetPeriod();
  }

  /**
   * Get time until next reset
   */
  getTimeUntilReset(): number {
    const periodMs = this.config.resetPeriodHours * 60 * 60 * 1000;
    const elapsed = Date.now() - this.periodStartTime;
    return Math.max(0, periodMs - elapsed);
  }

  // --------------------------------------------------------------------------
  // Estimation
  // --------------------------------------------------------------------------

  /**
   * Estimate cost for a planned operation
   */
  estimateCost(inputTokens: number, outputTokens: number, model: string): number {
    const pricing = this.getModelPricing(model);
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    return inputCost + outputCost;
  }

  /**
   * Check if estimated operation would exceed budget
   */
  wouldExceedBudget(estimatedCost: number): boolean {
    if (!this.config.enabled) return false;
    const currentCost = this.getCurrentCost();
    return (currentCost + estimatedCost) >= this.config.maxBudget;
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let budgetServiceInstance: BudgetService | null = null;

/**
 * Initialize BudgetService with configuration
 */
export function initBudgetService(config?: Partial<BudgetConfig>): BudgetService {
  if (!budgetServiceInstance) {
    budgetServiceInstance = new BudgetService(config);
  } else if (config) {
    budgetServiceInstance.updateConfig(config);
  }
  return budgetServiceInstance;
}

/**
 * Get the singleton BudgetService instance
 */
export function getBudgetService(): BudgetService {
  if (!budgetServiceInstance) {
    budgetServiceInstance = new BudgetService();
  }
  return budgetServiceInstance;
}

/**
 * 把持久化的预算配置写回运行时单例（Item4①）。
 * 抽成独立函数便于 IPC 写路径复用 + 单测，避免在 1300+ 行的 configService 里加逻辑。
 */
export function syncBudgetServiceFromConfig(budgetConfig: Partial<BudgetConfig>): void {
  getBudgetService().updateConfig(budgetConfig);
}

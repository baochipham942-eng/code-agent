// ============================================================================
// Reminder Budget - Token 预算管理
// ============================================================================
// 管理动态提醒的 token 预算
// 确保提醒不超过模型上下文窗口的合理比例
// ============================================================================

import type { ReminderDefinition, ReminderPriority } from '../generation/prompts/reminderRegistry';

/**
 * Token 预算配置
 */
export interface TokenBudgetConfig {
  maxReminderTokens: number;      // 提醒最大 token 数
  priorityBudgets: Record<ReminderPriority, number>; // 各优先级预算比例
  reservedTokens: number;         // 系统保留 token
  contextWindowSize: number;      // 上下文窗口大小
}

/**
 * 默认配置
 */
export const DEFAULT_BUDGET_CONFIG: TokenBudgetConfig = {
  maxReminderTokens: 1200,  // 增加以支持 PPT 等大型提醒 (700+ tokens)
  priorityBudgets: {
    1: 0.7,  // 关键提醒占 70%（支持 PPT 等重要任务提醒）
    2: 0.2, // 重要提醒占 20%
    3: 0.1, // 辅助提醒占 10%
  },
  reservedTokens: 200,
  contextWindowSize: 128000,
};

/**
 * Token 预算管理器
 */
export class TokenBudgetManager {
  private config: TokenBudgetConfig;
  private usedTokens: number = 0;
  private usedByPriority: Record<ReminderPriority, number> = { 1: 0, 2: 0, 3: 0 };

  constructor(config: Partial<TokenBudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  /**
   * 获取剩余预算
   */
  getRemainingBudget(): number {
    return Math.max(0, this.config.maxReminderTokens - this.usedTokens);
  }

  /**
   * 获取特定优先级的剩余预算
   */
  getRemainingBudgetForPriority(priority: ReminderPriority): number {
    const totalBudget = this.config.maxReminderTokens;
    const priorityBudget = totalBudget * this.config.priorityBudgets[priority];
    const used = this.usedByPriority[priority];
    return Math.max(0, priorityBudget - used);
  }

  /**
   * 检查是否可以分配 token
   */
  canAllocate(tokens: number, priority: ReminderPriority): boolean {
    // 检查总预算
    if (this.usedTokens + tokens > this.config.maxReminderTokens) {
      return false;
    }

    // 检查优先级预算（低优先级不能占用高优先级的预算）
    const priorityBudget = this.getRemainingBudgetForPriority(priority);
    return tokens <= priorityBudget;
  }

  /**
   * 分配 token
   */
  allocate(tokens: number, priority: ReminderPriority): boolean {
    if (!this.canAllocate(tokens, priority)) {
      return false;
    }

    this.usedTokens += tokens;
    this.usedByPriority[priority] += tokens;
    return true;
  }

  /**
   * 释放 token
   */
  release(tokens: number, priority: ReminderPriority): void {
    this.usedTokens = Math.max(0, this.usedTokens - tokens);
    this.usedByPriority[priority] = Math.max(0, this.usedByPriority[priority] - tokens);
  }

  /**
   * 重置预算
   */
  reset(): void {
    this.usedTokens = 0;
    this.usedByPriority = { 1: 0, 2: 0, 3: 0 };
  }

  /**
   * 获取预算使用统计
   */
  getStats(): {
    total: number;
    used: number;
    remaining: number;
    byPriority: Record<ReminderPriority, { budget: number; used: number; remaining: number }>;
    utilizationRate: number;
  } {
    const byPriority = {} as Record<
      ReminderPriority,
      { budget: number; used: number; remaining: number }
    >;

    for (const p of [1, 2, 3] as ReminderPriority[]) {
      const budget = this.config.maxReminderTokens * this.config.priorityBudgets[p];
      byPriority[p] = {
        budget,
        used: this.usedByPriority[p],
        remaining: Math.max(0, budget - this.usedByPriority[p]),
      };
    }

    return {
      total: this.config.maxReminderTokens,
      used: this.usedTokens,
      remaining: this.getRemainingBudget(),
      byPriority,
      utilizationRate: this.usedTokens / this.config.maxReminderTokens,
    };
  }
}

/**
 * 在预算内选择提醒
 */
export function selectRemindersWithinBudget(
  candidates: Array<{ reminder: ReminderDefinition; score: number }>,
  budgetManager: TokenBudgetManager
): ReminderDefinition[] {
  // 按优先级和分数排序
  const sorted = [...candidates].sort((a, b) => {
    // 优先级高的排前面
    if (a.reminder.priority !== b.reminder.priority) {
      return a.reminder.priority - b.reminder.priority;
    }
    // 分数高的排前面
    return b.score - a.score;
  });

  const selected: ReminderDefinition[] = [];

  for (const { reminder, score } of sorted) {
    // 跳过分数为 0 的
    if (score === 0) continue;

    // 尝试分配预算
    if (budgetManager.allocate(reminder.tokens, reminder.priority)) {
      selected.push(reminder);
    }
  }

  return selected;
}

/**
 * 估算提醒列表的总 token 数
 */
export function estimateTotalTokens(reminders: ReminderDefinition[]): number {
  return reminders.reduce((sum, r) => sum + r.tokens, 0);
}

/**
 * 根据上下文动态调整预算
 */
export function adjustBudgetForContext(
  baseConfig: TokenBudgetConfig,
  context: {
    conversationLength: number;
    hasComplexTask: boolean;
    isInPlanMode: boolean;
  }
): TokenBudgetConfig {
  const adjusted = { ...baseConfig };

  // 长对话时减少提醒预算
  if (context.conversationLength > 20) {
    adjusted.maxReminderTokens = Math.floor(baseConfig.maxReminderTokens * 0.7);
  }

  // 复杂任务时增加关键提醒预算
  if (context.hasComplexTask) {
    adjusted.priorityBudgets = {
      ...adjusted.priorityBudgets,
      1: 0.6, // 增加关键提醒比例
      2: 0.3,
      3: 0.1,
    };
  }

  // Plan Mode 时调整预算
  if (context.isInPlanMode) {
    adjusted.maxReminderTokens = Math.floor(baseConfig.maxReminderTokens * 0.8);
  }

  return adjusted;
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let budgetManagerInstance: TokenBudgetManager | null = null;

export function getTokenBudgetManager(
  config?: Partial<TokenBudgetConfig>
): TokenBudgetManager {
  if (!budgetManagerInstance || config) {
    budgetManagerInstance = new TokenBudgetManager(config);
  }
  return budgetManagerInstance;
}

export function resetTokenBudgetManager(): void {
  if (budgetManagerInstance) {
    budgetManagerInstance.reset();
  }
}

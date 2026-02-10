// ============================================================================
// Goal Tracker - Manus-style periodic goal re-injection
// Prevents LLM drift after 50+ tool calls by mechanically re-injecting
// the original goal and progress summary every N iterations.
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('GoalTracker');

/**
 * GoalTracker — 目标追踪 + 周期性重注入
 *
 * 核心理念：不信任 LLM 的长期记忆，用机械化注入在关键决策点重刷目标和上下文。
 * 借鉴 planning-with-files 的 Manus 风格 context engineering。
 */
export class GoalTracker {
  private goal: string = '';
  private completedActions: string[] = [];  // 最近 10 个
  private pendingActions: string[] = [];
  private initialized: boolean = false;
  private readonly interval: number;

  constructor(interval: number = 3) {
    this.interval = interval;
  }

  /**
   * 从用户消息提取目标：取第一句话（支持中英文句号），截断到 100 字
   */
  initialize(userMessage: string): void {
    if (!userMessage?.trim()) return;

    // 提取第一句话（中英文句号、问号、感叹号、换行）
    const sentenceEnd = userMessage.search(/[。.!！?？\n]/);
    const firstSentence = sentenceEnd >= 0
      ? userMessage.substring(0, sentenceEnd + 1)
      : userMessage;

    // 截断到 100 字
    this.goal = firstSentence.length > 100
      ? firstSentence.substring(0, 100) + '...'
      : firstSentence;

    this.completedActions = [];
    this.pendingActions = [];
    this.initialized = true;

    logger.debug('[GoalTracker] Initialized', { goal: this.goal });
  }

  /**
   * 记录成功的工具动作（保留最近 10 个）。
   * 失败的工具调用不记入 pending，因为 tool name 粒度太粗会导致误判。
   */
  recordAction(description: string, completed: boolean): void {
    if (!this.initialized || !completed) return;

    // 去重：同名工具不重复记录
    if (!this.completedActions.includes(description)) {
      this.completedActions.push(description);
      // 保留最近 10 个
      if (this.completedActions.length > 10) {
        this.completedActions.shift();
      }
    }
  }

  /**
   * 生成目标检查点注入（仅在 iteration % interval === 0 时返回）
   */
  getGoalCheckpoint(iteration: number): string | null {
    if (!this.initialized) return null;
    if (iteration <= 0 || iteration % this.interval !== 0) return null;

    const completedList = this.completedActions.length > 0
      ? this.completedActions.join(', ')
      : '无';

    const pendingList = this.pendingActions.length > 0
      ? this.pendingActions.join(', ')
      : '无';

    return (
      `<goal-checkpoint>\n` +
      `原始目标: ${this.goal}\n` +
      `已完成: ${completedList}\n` +
      `待完成: ${pendingList}\n` +
      `当前第 ${iteration} 轮\n` +
      `</goal-checkpoint>`
    );
  }

  /**
   * 返回目标摘要（供 P4 Nudge 使用）
   */
  getGoalSummary(): { goal: string; completed: string[]; pending: string[] } {
    return {
      goal: this.goal,
      completed: [...this.completedActions],
      pending: [...this.pendingActions],
    };
  }

  /**
   * 是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.goal = '';
    this.completedActions = [];
    this.pendingActions = [];
    this.initialized = false;
  }
}

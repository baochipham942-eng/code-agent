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
interface FailedAction {
  description: string;
  errorHint: string;
}

export class GoalTracker {
  private goal: string = '';
  private completedActions: string[] = [];  // 最近 10 个成功
  private failedActions: FailedAction[] = [];  // 最近 5 个失败（带 error hint）
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
    // 半角 `.` 必须后接空白或字符串结尾才算句尾，避免把 URL 的 `.` 当句号截断
    // （历史 Bug：`https://www.xiaohongshu.com/...` 被截到 `https://www.`，
    // 每 3 轮 checkpoint 注入残缺 URL 误导模型）
    const sentenceEnd = userMessage.search(/[。!！?？\n]|\.(?=\s|$)/);
    const firstSentence = sentenceEnd >= 0
      ? userMessage.substring(0, sentenceEnd + 1)
      : userMessage;

    // 截断到 100 字
    this.goal = firstSentence.length > 100
      ? firstSentence.substring(0, 100) + '...'
      : firstSentence;

    this.completedActions = [];
    this.failedActions = [];
    this.pendingActions = [];
    this.initialized = true;

    logger.debug('[GoalTracker] Initialized', { goal: this.goal });
  }

  /**
   * 记录工具动作。
   * 成功：记入 completedActions（保留最近 10 个，按工具名去重）
   * 失败：记入 failedActions（保留最近 5 个，带 errorHint，模型在 checkpoint 看见后能主动反问或换路径）
   *
   * 历史选择：原实现 `if (!completed) return` 直接丢失败信号，导致模型看不到 N 次失败后仍以为顺利。
   * 新做法：失败也记，但用 errorHint（截断 80 字符）保持精度，避免 tool name 粒度太粗导致的误判。
   */
  recordAction(description: string, success: boolean, errorHint?: string): void {
    if (!this.initialized) return;

    if (success) {
      // 去重：同名工具不重复记录
      if (!this.completedActions.includes(description)) {
        this.completedActions.push(description);
        if (this.completedActions.length > 10) {
          this.completedActions.shift();
        }
      }
      return;
    }

    // 失败：记入 failedActions，截断 errorHint 控制 token
    const trimmedHint = (errorHint || '未知错误').substring(0, 80);
    this.failedActions.push({ description, errorHint: trimmedHint });
    if (this.failedActions.length > 5) {
      this.failedActions.shift();
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

    const failedList = this.failedActions.length > 0
      ? this.failedActions.map(f => `${f.description}(${f.errorHint})`).join('; ')
      : '无';

    const pendingList = this.pendingActions.length > 0
      ? this.pendingActions.join(', ')
      : '无';

    // 失败计数 ≥ 2 时追加显式提示，让模型主动反问或换路径
    const failureNudge = this.failedActions.length >= 2
      ? `\n⚠️ 已失败 ${this.failedActions.length} 次。如果根因是用户输入参数模糊（URL 残缺/ID 格式不对/路径不明），立即调 AskUserQuestion 反问，不要再猜。`
      : '';

    return (
      `<goal-checkpoint>\n` +
      `原始目标: ${this.goal}\n` +
      `已成功: ${completedList}\n` +
      `失败重试: ${failedList}\n` +
      `待完成: ${pendingList}\n` +
      `当前第 ${iteration} 轮${failureNudge}\n` +
      `</goal-checkpoint>`
    );
  }

  /**
   * 返回目标摘要（供 P4 Nudge 使用）
   */
  getGoalSummary(): {
    goal: string;
    completed: string[];
    failed: FailedAction[];
    pending: string[];
  } {
    return {
      goal: this.goal,
      completed: [...this.completedActions],
      failed: [...this.failedActions],
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
    this.failedActions = [];
    this.pendingActions = [];
    this.initialized = false;
  }
}

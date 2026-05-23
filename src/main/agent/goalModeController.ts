// ============================================================================
// GoalModeController — /goal 自治循环的状态机 + 闸3 兜底
// 设计见 docs/designs/goal-mode.md
// ============================================================================

import { GOAL_MODE } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('GoalModeController');

export type GoalStatus = 'pending' | 'met' | 'aborted';

/** 用户下达 /goal 时解析出的契约 */
export interface GoalContract {
  /** 自然语言目标 */
  goal: string;
  /** 闸1：退出码 0 即硬达成的 shell 命令（强制必填，见 design D1） */
  verifyCommand: string;
  /** 闸2：可选，交给 Reviewer 子代理评的软条件 */
  reviewCondition?: string;
  /** 闸3：token 预算上限 */
  tokenBudget: number;
  /** 闸3：轮次上限 */
  maxTurns: number;
}

/** 闸3 判定结果 */
export interface FallbackResult {
  stop: boolean;
  /** stop=true 时的中止原因（用于报告人 + 标 aborted） */
  reason?: string;
}

/**
 * 从解析出的参数 + 默认值构建 goal 契约。
 * tokenBudget / maxTurns 缺省时回落到 GOAL_MODE 常量（禁硬编码）。
 */
export function buildGoalContract(input: {
  goal: string;
  verifyCommand: string;
  reviewCondition?: string;
  tokenBudget?: number;
  maxTurns?: number;
}): GoalContract {
  return {
    goal: input.goal,
    verifyCommand: input.verifyCommand,
    reviewCondition: input.reviewCondition,
    tokenBudget: input.tokenBudget ?? GOAL_MODE.DEFAULT_TOKEN_BUDGET,
    maxTurns: input.maxTurns ?? GOAL_MODE.DEFAULT_MAX_TURNS,
  };
}

/**
 * GoalModeController — /goal 自治循环的状态机 + 闸3 兜底
 *
 * 职责边界（见 docs/designs/goal-mode.md §3）：
 * - 完成判定权在代码层。模型调 attempt_completion 只是"申请退出"。
 * - 闸1（Awaiter 跑 verify 命令）/ 闸2（Reviewer 评审）由 loop 编排——它们要派
 *   子代理、依赖 provider 层，不放本类，以保持本类无 provider 依赖、可独立单测。
 * - 本类只负责：持有契约、跟踪 goalStatus、纯代码层的闸3（预算/轮次/无进展）。
 */
export class GoalModeController {
  private readonly contract: GoalContract;
  private status: GoalStatus = 'pending';
  /** 连续无文件变更的轮次计数（闸3 无进展检测） */
  private noProgressTurns = 0;
  private abortReason?: string;

  constructor(contract: GoalContract) {
    this.contract = contract;
  }

  getGoal(): string { return this.contract.goal; }
  getVerifyCommand(): string { return this.contract.verifyCommand; }
  getReviewCondition(): string | undefined { return this.contract.reviewCondition; }
  getStatus(): GoalStatus { return this.status; }
  isPending(): boolean { return this.status === 'pending'; }
  getAbortReason(): string | undefined { return this.abortReason; }

  /** 模型申请退出且闸1（+闸2）全过 → 标达成 */
  markMet(): void {
    this.status = 'met';
    logger.debug('[GoalMode] goal marked met');
  }

  /** 闸3 兜底触发 → 标中止 */
  markAborted(reason: string): void {
    this.status = 'aborted';
    this.abortReason = reason;
    logger.warn('[GoalMode] goal aborted', { reason });
  }

  /**
   * 每轮记录是否有文件变更，更新无进展计数。
   * 有变更 → 清零；无变更 → 累加。
   */
  recordTurnProgress(hadFileChange: boolean): void {
    if (hadFileChange) {
      this.noProgressTurns = 0;
    } else {
      this.noProgressTurns += 1;
    }
  }

  /**
   * 闸3：纯代码层兜底判定。任一触发即返回 stop=true + reason。
   * 由 loop 每轮调用，写在代码层，模型无法绕过。
   */
  evaluateFallback(input: { turn: number; tokensUsed: number }): FallbackResult {
    if (input.turn >= this.contract.maxTurns) {
      return { stop: true, reason: `达到轮次上限 ${this.contract.maxTurns}，目标未达成` };
    }
    if (input.tokensUsed >= this.contract.tokenBudget) {
      return { stop: true, reason: `达到 token 预算上限 ${this.contract.tokenBudget}，目标未达成` };
    }
    if (this.noProgressTurns >= GOAL_MODE.NO_PROGRESS_THRESHOLD) {
      return { stop: true, reason: `连续 ${this.noProgressTurns} 轮无文件变更，判定无进展` };
    }
    return { stop: false };
  }
}

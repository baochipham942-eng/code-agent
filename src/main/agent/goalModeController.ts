// ============================================================================
// GoalModeController — /goal 自治循环的状态机 + 闸3 兜底
// 设计见 docs/designs/goal-mode.md
// ============================================================================

import { GOAL_MODE, SWARM_GOAL } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('GoalModeController');

export type GoalStatus = 'pending' | 'met' | 'aborted';

/** 用户下达 /goal 时解析出的契约 */
export interface GoalContract {
  /** 自然语言目标 */
  goal: string;
  /**
   * 闸1：退出码 0 即硬达成的 shell 命令。可选——纯软目标只给 reviewCondition 时缺省，
   * 此时跳过闸1 直接走闸2。校验保证 verifyCommand / reviewCondition 至少有一个（见 design §4）。
   */
  verifyCommand?: string;
  /** 闸2：可选，交给 Reviewer 子代理评的软条件 */
  reviewCondition?: string;
  /** 闸3：token 预算上限 */
  tokenBudget: number;
  /** 闸3：轮次上限 */
  maxTurns: number;
  /**
   * 闸3：墙钟时间预算上限（ms，可选）。缺省 = 不限时。
   * 与 token/轮次互补——专治"token 没烧完、轮次没用尽，却卡在慢动作（跑测试、网络、
   * 子 agent 扇出）里闷头耗时间"的黑洞，无人值守场景的时间护栏。
   */
  wallClockBudgetMs?: number;
  /**
   * 是否允许 swarm 扇出（控制 workflow 工具预加载 + 预算注入，docs/designs/swarm-goal.md）。
   * 交互式 /goal 默认 true；主动性 advance 发起的 goal run 强制 false（无人值守不扇出）。
   */
  allowSwarm?: boolean;
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
  verifyCommand?: string;
  reviewCondition?: string;
  tokenBudget?: number;
  maxTurns?: number;
  wallClockBudgetMs?: number;
  allowSwarm?: boolean;
}): GoalContract {
  if (!input.verifyCommand && !input.reviewCondition) {
    // 防御：契约级再兜一层（schema 已校验），纯空目标无完成判据 → 永远只能 abort。
    throw new Error('goal 契约至少需要 verifyCommand 或 reviewCondition 之一');
  }
  return {
    goal: input.goal,
    verifyCommand: input.verifyCommand,
    reviewCondition: input.reviewCondition,
    tokenBudget: input.tokenBudget ?? GOAL_MODE.DEFAULT_TOKEN_BUDGET,
    maxTurns: input.maxTurns ?? GOAL_MODE.DEFAULT_MAX_TURNS,
    // 缺省 undefined = 不限时（纯加法，不改没设墙钟的旧 goal 行为）
    wallClockBudgetMs: input.wallClockBudgetMs,
    // 缺省 = 允许扇出（交互式 /goal）；主动性 advance 路径显式传 false
    allowSwarm: input.allowSwarm ?? true,
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
  /** 模型是否已调 attempt_completion 申请退出（待闸1/闸2 验证；不直接改 status） */
  private completionRequested = false;
  private pendingSummary?: string;
  /** swarm（workflow 子 agent）累计消耗的 token —— 计入闸3 预算（docs/designs/swarm-goal.md §4） */
  private swarmTokensUsed = 0;

  constructor(contract: GoalContract) {
    this.contract = contract;
  }

  getGoal(): string { return this.contract.goal; }
  getVerifyCommand(): string | undefined { return this.contract.verifyCommand; }
  getReviewCondition(): string | undefined { return this.contract.reviewCondition; }
  getStatus(): GoalStatus { return this.status; }
  isPending(): boolean { return this.status === 'pending'; }
  getAbortReason(): string | undefined { return this.abortReason; }
  getTokenBudget(): number { return this.contract.tokenBudget; }
  getMaxTurns(): number { return this.contract.maxTurns; }
  /** 墙钟时间预算（ms）；undefined = 不限时（①，UI 用来显示剩余时间） */
  getWallClockBudgetMs(): number | undefined { return this.contract.wallClockBudgetMs; }
  /** 是否允许 swarm 扇出（workflow 工具预加载 + 预算注入的总开关） */
  allowsSwarm(): boolean { return this.contract.allowSwarm ?? true; }

  // ==========================================================================
  // Swarm 预算（P4：上行记账 + 下行 clamp，docs/designs/swarm-goal.md §4.1）
  // ==========================================================================

  /**
   * 上行记账：workflow 工具结果的 meta.tokensSpent → 计入 goal 消耗。
   * 防御：undefined / NaN / 负数一律跳过（记账缺失不影响主流程，仍有 maxTurns 兜底）。
   */
  recordSwarmTokens(tokens: unknown): void {
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
      return;
    }
    this.swarmTokensUsed += Math.floor(tokens);
    logger.debug('[GoalMode] swarm tokens recorded', { tokens, total: this.swarmTokensUsed });
  }

  /** swarm 累计消耗（闸3 evaluateFallback 与 goal_iteration 事件的 tokensUsed 须计入） */
  getSwarmTokensUsed(): number {
    return this.swarmTokensUsed;
  }

  /**
   * 下行 clamp：goal 模式下 workflow 工具调用的 budgetTokens 不可信模型自报，
   * 压到「goal 剩余预算 × MAX_BUDGET_FRACTION」以内。
   * @param requested 模型自报的 budgetTokens（可能缺省）
   * @param mainTokensUsed 主 agent 已消耗的 token（input + output）
   * @returns clamp 后的预算（≥0；0 表示剩余预算已耗尽，调用方应拒绝扇出）
   */
  clampSwarmBudget(requested: number | undefined, mainTokensUsed: number): number {
    const remaining = Math.max(0, this.contract.tokenBudget - mainTokensUsed - this.swarmTokensUsed);
    const ceiling = Math.floor(remaining * SWARM_GOAL.MAX_BUDGET_FRACTION);
    if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
      return ceiling;
    }
    return Math.min(Math.floor(requested), ceiling);
  }

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

  /** 模型调 attempt_completion → 记申请退出。不改 status——met 由闸1/闸2 全过后 markMet 决定 */
  requestCompletion(summary: string): void {
    this.completionRequested = true;
    this.pendingSummary = summary;
    logger.debug('[GoalMode] completion requested (pending verification)');
  }

  hasPendingCompletionRequest(): boolean {
    return this.completionRequested;
  }

  getPendingSummary(): string | undefined {
    return this.pendingSummary;
  }

  /** 闸验证处理完后清空申请（无论通过与否） */
  clearCompletionRequest(): void {
    this.completionRequested = false;
    this.pendingSummary = undefined;
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
   *
   * 注：input.tokensUsed 是主 agent 消耗（input + output）；swarm 子 agent 消耗
   * （recordSwarmTokens 记账）在本方法内部统一计入，调用方无需自己加总。
   */
  evaluateFallback(input: { turn: number; tokensUsed: number; elapsedMs?: number }): FallbackResult {
    if (input.turn >= this.contract.maxTurns) {
      return { stop: true, reason: `达到轮次上限 ${this.contract.maxTurns}，目标未达成` };
    }
    const totalTokensUsed = input.tokensUsed + this.swarmTokensUsed;
    if (totalTokensUsed >= this.contract.tokenBudget) {
      const swarmNote = this.swarmTokensUsed > 0 ? `（含 swarm 子 agent 消耗 ${this.swarmTokensUsed}）` : '';
      return { stop: true, reason: `达到 token 预算上限 ${this.contract.tokenBudget}${swarmNote}，目标未达成` };
    }
    // 墙钟时间兜底（①）：仅当契约设了上限且调用方传了已用时间才生效——缺省即跳过，旧行为不变。
    if (
      this.contract.wallClockBudgetMs !== undefined &&
      input.elapsedMs !== undefined &&
      input.elapsedMs >= this.contract.wallClockBudgetMs
    ) {
      const mins = Math.round(this.contract.wallClockBudgetMs / 60_000);
      return { stop: true, reason: `达到墙钟时间上限 ${mins} 分钟，目标未达成` };
    }
    if (this.noProgressTurns >= GOAL_MODE.NO_PROGRESS_THRESHOLD) {
      return { stop: true, reason: `连续 ${this.noProgressTurns} 轮无文件变更，判定无进展` };
    }
    return { stop: false };
  }

  /**
   * goal 仍 pending 时，每轮注给模型的续跑提示。
   * 显式告知"完成判定走代码层验证命令"，对抗 Ralph 式"模型说完就完"。
   */
  buildContinuationPrompt(): string {
    return [
      '<goal-continuation>',
      `目标尚未达成，继续推进。原始目标：${this.contract.goal}`,
      '当你确信达成时，调用 attempt_completion 申请退出；',
      `系统会自动${this.describeGates()}来核实，核实通过才算完成。`,
      '不要仅凭"我觉得做完了"就停下——没调 attempt_completion 或核实不过，都会被要求继续。',
      '</goal-continuation>',
    ].join('\n');
  }

  /** 描述当前契约的完成判据（用于注入提示），按 verify/review 有无组合。 */
  private describeGates(): string {
    const parts: string[] = [];
    if (this.contract.verifyCommand) parts.push(`运行验证命令 \`${this.contract.verifyCommand}\``);
    if (this.contract.reviewCondition) parts.push('派评审子代理核实软条件');
    return parts.join(' 并 ');
  }

  /**
   * 是否在本轮重注入审计 nudge：每 CHECKPOINT_INTERVAL 轮一次（首轮不注）。
   * 周期性而非每轮——审计提示较长，每轮注会撑 token 且模型会脱敏。
   */
  shouldInjectAudit(turn: number): boolean {
    // 自适应（②）：纯软目标（无 verify 命令）多为轻任务，拉长自检间隔省 token；
    // 有 verify 命令的工程任务维持基础间隔，保持高频证据自检。
    const interval = this.contract.verifyCommand
      ? GOAL_MODE.CHECKPOINT_INTERVAL
      : GOAL_MODE.SIMPLE_CHECKPOINT_INTERVAL;
    return turn > 1 && turn % interval === 0;
  }

  /**
   * Swarm 编排引导（P4，仅 allowSwarm 时在 goal run 首轮注入一次）：
   * 告知模型可用 workflow 工具扇出并行子 agent，并框定使用边界
   * （只有天然可并行的目标才扇出 + 预算受 goal 剩余预算约束 + 子任务建议带验证 stage）。
   */
  buildSwarmGuidance(): string {
    return [
      '<goal-swarm-guidance>',
      '本 goal 支持多 agent 并行执行：当目标天然可并行（多个相互独立的子任务，如修多个测试文件、',
      '给多个模块写文档）时，你可以调用 workflow 工具，当场写一段编排脚本扇出并行子 agent 分头干。',
      '使用约束：',
      '1. 只有天然可并行的目标才扇出——单线任务直接自己做，扇出反而浪费；',
      '2. 扇出预算由系统自动限制在 goal 剩余预算以内，无需你自己计算；',
      '3. 编排脚本里建议给关键子任务写验证 stage（让另一个子 agent 检查产出），脏结果不要直接收；',
      '4. 子 agent 的产出汇总回来后，仍由你负责整体收尾——最终完成判定依然要过系统的验证闸。',
      '</goal-swarm-guidance>',
    ].join('\n');
  }

  /**
   * Codex 式审计 nudge（参考 pi-goal 上下文注入）：周期性强制注入，框定模型
   * "先假设目标【未】达成、再逐项找证据反驳"，对抗模型凭感觉过早自报完成。
   * 与 buildContinuationPrompt 分工：后者在模型 text-stop 时催"继续"，本提示是
   * 主动的完成前自检框架，并点明完成仍要过代码层闸（verify 命令 + 可选评审）。
   */
  buildAuditNudge(): string {
    return [
      '<goal-audit>',
      '完成前自检——先假设目标【尚未】达成，再逐项找证据反驳这个假设：',
      `原始目标：${this.contract.goal}`,
      '1. 把目标拆成可检验的子要求；',
      '2. 对每一项找出【具体证据】（哪个文件的哪段内容、哪条命令的输出）证明已满足；',
      '3. 凡是只"觉得"做了却拿不出证据的子要求，一律按未完成处理，继续做。',
      `只有每一项都有证据时才调 attempt_completion——届时系统仍会独立${this.describeGates()}，过不了照样打回。`,
      '</goal-audit>',
    ].join('\n');
  }
}

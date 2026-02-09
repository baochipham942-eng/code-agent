// ============================================================================
// Autonomous Loop - 目标驱动的自主迭代循环
// ============================================================================
// 用户设定目标 + 退出条件，Agent 自主循环直到满足或预算耗尽。
// 类似 Carlini 的 "while true" harness。
//
// 流程：
// for i in 0..maxOuterIterations:
//   1. 检查预算 → 超限则退出
//   2. 构建 prompt（首轮=目标，后续=目标+上轮验证反馈）
//   3. 运行内层 AgentLoop
//   4. 运行 Verifier 验证结果
//   5. 检查退出条件 → 满足则退出
//   6. 若连续 2 轮无改善 → 退出
//   7. 记录最优结果
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import { getVerifierRegistry, initializeVerifiers } from '../verifier';
import type { VerificationResult, VerificationContext } from '../verifier/verifierRegistry';
import { ExitCriteriaEvaluator } from './exitCriteria';
import { analyzeTask, type TaskAnalysis } from '../hybrid/taskRouter';

const logger = createLogger('AutonomousLoop');

// ============================================================================
// Types
// ============================================================================

export interface AutonomousConfig {
  /** Maximum outer iterations (default: 5) */
  maxOuterIterations: number;
  /** Maximum budget in USD (default: 2.0) */
  maxBudgetUSD: number;
  /** Maximum total time in ms (default: 600000 = 10 min) */
  maxTotalTimeMs: number;
  /** Score threshold to consider task complete (default: 0.7) */
  scoreThreshold: number;
  /** Minimum improvement between iterations (default: 0.01) */
  minImprovement: number;
}

export interface AutonomousIterationResult {
  iteration: number;
  agentOutput: string;
  verification: VerificationResult;
  costUSD: number;
  durationMs: number;
  toolCalls: VerificationContext['toolCalls'];
  modifiedFiles: string[];
}

export interface AutonomousResult {
  success: boolean;
  iterations: AutonomousIterationResult[];
  bestIteration: number;
  bestScore: number;
  totalCostUSD: number;
  totalDurationMs: number;
  exitReason: string;
  finalOutput: string;
}

/**
 * Callback to execute a single inner agent loop iteration
 */
export type InnerLoopExecutor = (
  prompt: string,
  iteration: number
) => Promise<{
  output: string;
  costUSD: number;
  toolCalls?: VerificationContext['toolCalls'];
  modifiedFiles?: string[];
}>;

const DEFAULT_CONFIG: AutonomousConfig = {
  maxOuterIterations: 5,
  maxBudgetUSD: 2.0,
  maxTotalTimeMs: 600000, // 10 minutes
  scoreThreshold: 0.7,
  minImprovement: 0.01,
};

// ============================================================================
// Autonomous Loop
// ============================================================================

export class AutonomousLoop {
  private config: AutonomousConfig;
  private exitCriteria: ExitCriteriaEvaluator;
  private cancelled = false;

  constructor(config?: Partial<AutonomousConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.exitCriteria = new ExitCriteriaEvaluator({
      scoreThreshold: this.config.scoreThreshold,
      minImprovement: this.config.minImprovement,
    });
  }

  /**
   * Execute the autonomous loop
   *
   * @param goal - The user's goal/task description
   * @param executor - Function to run a single inner AgentLoop iteration
   * @param workingDirectory - Working directory for verification
   * @param onIteration - Optional callback for progress updates
   */
  async run(
    goal: string,
    executor: InnerLoopExecutor,
    workingDirectory: string,
    onIteration?: (result: AutonomousIterationResult, total: number) => void
  ): Promise<AutonomousResult> {
    const startTime = Date.now();
    let totalCostUSD = 0;
    const iterations: AutonomousIterationResult[] = [];
    let bestIteration = 0;
    let bestScore = 0;

    // Initialize verifiers
    initializeVerifiers();
    const verifierRegistry = getVerifierRegistry();
    const taskAnalysis = analyzeTask(goal);

    // Reset exit criteria
    this.exitCriteria.reset();
    this.cancelled = false;

    logger.info('Starting autonomous loop', {
      goal: goal.slice(0, 100),
      config: this.config,
    });

    for (let i = 0; i < this.config.maxOuterIterations; i++) {
      if (this.cancelled) {
        logger.info('Autonomous loop cancelled');
        break;
      }

      // 1. Check budget
      if (totalCostUSD >= this.config.maxBudgetUSD) {
        logger.info(`Budget exceeded: $${totalCostUSD.toFixed(4)} >= $${this.config.maxBudgetUSD}`);
        return this.buildResult(iterations, bestIteration, bestScore, totalCostUSD, startTime, 'Budget exceeded');
      }

      // Check time
      if (Date.now() - startTime >= this.config.maxTotalTimeMs) {
        logger.info('Time limit exceeded');
        return this.buildResult(iterations, bestIteration, bestScore, totalCostUSD, startTime, 'Time limit exceeded');
      }

      // 2. Build prompt
      const prompt = this.buildPrompt(goal, i, iterations);

      // 3. Run inner AgentLoop
      const iterationStart = Date.now();
      logger.info(`Autonomous iteration ${i + 1}/${this.config.maxOuterIterations}`);

      let innerResult: Awaited<ReturnType<InnerLoopExecutor>>;
      try {
        innerResult = await executor(prompt, i);
      } catch (error) {
        logger.error(`Iteration ${i + 1} failed:`, error);
        const failedIteration: AutonomousIterationResult = {
          iteration: i,
          agentOutput: `Error: ${error instanceof Error ? error.message : String(error)}`,
          verification: {
            passed: false,
            score: 0,
            checks: [],
            taskType: 'generic',
            durationMs: 0,
          },
          costUSD: 0,
          durationMs: Date.now() - iterationStart,
          toolCalls: [],
          modifiedFiles: [],
        };
        iterations.push(failedIteration);
        continue;
      }

      totalCostUSD += innerResult.costUSD;

      // 4. Run Verifier
      const verificationContext: VerificationContext = {
        taskDescription: goal,
        taskAnalysis,
        agentOutput: innerResult.output,
        toolCalls: innerResult.toolCalls,
        workingDirectory,
        modifiedFiles: innerResult.modifiedFiles,
      };

      const verification = await verifierRegistry.verifyTask(verificationContext, taskAnalysis);

      const iterationResult: AutonomousIterationResult = {
        iteration: i,
        agentOutput: innerResult.output,
        verification,
        costUSD: innerResult.costUSD,
        durationMs: Date.now() - iterationStart,
        toolCalls: innerResult.toolCalls || [],
        modifiedFiles: innerResult.modifiedFiles || [],
      };

      iterations.push(iterationResult);

      // Track best
      if (verification.score > bestScore) {
        bestScore = verification.score;
        bestIteration = i;
      }

      // Notify progress
      onIteration?.(iterationResult, this.config.maxOuterIterations);

      logger.info(`Iteration ${i + 1} result: score=${verification.score.toFixed(2)} passed=${verification.passed}`, {
        checks: verification.checks.map(c => `${c.name}:${c.passed}`).join(', '),
      });

      // 5. Check exit conditions
      const exitEval = this.exitCriteria.evaluate(verification);
      if (exitEval.shouldExit) {
        logger.info(`Exit criteria met: ${exitEval.reason}`);
        return this.buildResult(iterations, bestIteration, bestScore, totalCostUSD, startTime, exitEval.reason);
      }
    }

    return this.buildResult(
      iterations, bestIteration, bestScore, totalCostUSD, startTime,
      `Max iterations (${this.config.maxOuterIterations}) reached`
    );
  }

  /**
   * Cancel the autonomous loop
   */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Build prompt for the current iteration
   */
  private buildPrompt(
    goal: string,
    iteration: number,
    previousIterations: AutonomousIterationResult[]
  ): string {
    if (iteration === 0) {
      return goal;
    }

    // Build feedback from previous iteration
    const lastIteration = previousIterations[previousIterations.length - 1];
    const feedback = lastIteration.verification;

    const failedChecks = feedback.checks
      .filter(c => !c.passed)
      .map(c => `- ${c.name}: ${c.message}`)
      .join('\n');

    const suggestions = feedback.suggestions?.join('\n- ') || 'None';

    return `${goal}

---
[自主迭代 ${iteration + 1}] 上一轮验证反馈：
- 得分: ${feedback.score.toFixed(2)}/1.0 (${feedback.passed ? '通过' : '未通过'})
- 失败的检查:
${failedChecks || '  无'}
- 改进建议:
- ${suggestions}

请根据以上反馈修正问题，确保所有验证检查通过。`;
  }

  /**
   * Build the final result
   */
  private buildResult(
    iterations: AutonomousIterationResult[],
    bestIteration: number,
    bestScore: number,
    totalCostUSD: number,
    startTime: number,
    exitReason: string
  ): AutonomousResult {
    const finalOutput = iterations.length > 0
      ? iterations[bestIteration]?.agentOutput || ''
      : '';

    return {
      success: bestScore >= this.config.scoreThreshold,
      iterations,
      bestIteration,
      bestScore,
      totalCostUSD,
      totalDurationMs: Date.now() - startTime,
      exitReason,
      finalOutput,
    };
  }
}

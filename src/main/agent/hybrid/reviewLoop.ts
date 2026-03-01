// ============================================================================
// Review Loop - Worker→Verifier→Reviewer iterative quality cycle
// ============================================================================
// Harness Engineering: Agent 写完代码后自动进入 review→revise→re-review 循环
// 核心设计:
// - maxIterations=3, passThreshold=0.8
// - 分数无提升时提前退出（防无效循环）
// - 简单任务跳过 Review Loop（由 taskRouter 决策）
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import { getVerifierRegistry } from '../verifier';
import type { VerificationContext, VerificationResult } from '../verifier/verifierRegistry';
import type { TaskAnalysis } from './taskRouter';

const logger = createLogger('ReviewLoop');

// ============================================================================
// Types
// ============================================================================

export interface ReviewLoopConfig {
  /** Maximum review iterations before forced exit */
  maxIterations: number;
  /** Score threshold to pass (0-1) */
  passThreshold: number;
  /** Minimum score improvement between iterations to continue */
  minImprovement: number;
}

export const DEFAULT_REVIEW_LOOP_CONFIG: ReviewLoopConfig = {
  maxIterations: 3,
  passThreshold: 0.8,
  minImprovement: 0.05,
};

export interface ReviewIteration {
  iteration: number;
  score: number;
  passed: boolean;
  feedback: string[];
  durationMs: number;
}

export interface ReviewLoopResult {
  /** Final verification result */
  finalResult: VerificationResult;
  /** Whether the task passed review */
  passed: boolean;
  /** All iterations history */
  iterations: ReviewIteration[];
  /** Total duration of the review loop */
  totalDurationMs: number;
  /** Whether the loop was skipped (simple task) */
  skipped: boolean;
  /** Reason for exit */
  exitReason: 'passed' | 'max_iterations' | 'no_improvement' | 'skipped' | 'no_verifier';
}

/**
 * Worker executor function — takes feedback and produces revised output
 */
export type WorkerExecutor = (
  feedback: string[],
  previousOutput: string,
  iteration: number,
) => Promise<{ output: string; modifiedFiles: string[] }>;

// ============================================================================
// Review Loop Implementation
// ============================================================================

/**
 * Determine if a task should use the Review Loop
 */
export function shouldUseReviewLoop(taskAnalysis: TaskAnalysis): boolean {
  // Simple tasks skip the review loop
  if (taskAnalysis.complexity === 'simple') return false;

  // Tasks with fewer than 3 estimated steps are too small
  if (taskAnalysis.estimatedSteps < 3) return false;

  // Code and data tasks benefit most from review
  const reviewableTypes = ['code', 'data', 'ppt', 'document'];
  if (!reviewableTypes.includes(taskAnalysis.taskType)) return false;

  return true;
}

/**
 * Format verification feedback into actionable instructions for the worker
 */
export function formatFeedbackForRevision(result: VerificationResult): string[] {
  const feedback: string[] = [];

  // Add failed check details
  for (const check of result.checks) {
    if (!check.passed) {
      feedback.push(`[FAIL] ${check.name}: ${check.message} (score: ${check.score.toFixed(2)})`);
    }
  }

  // Add verifier suggestions
  if (result.suggestions?.length) {
    feedback.push('--- Suggestions ---');
    for (const suggestion of result.suggestions) {
      feedback.push(`→ ${suggestion}`);
    }
  }

  return feedback;
}

/**
 * Execute the Review Loop
 *
 * Flow:
 * Worker executes → Verifier checks deterministically →
 *   score < threshold? → Reviewer generates feedback → Worker revises → re-verify
 *   score >= threshold? → Pass
 *   iterations >= max? → Force exit with best result
 */
export async function executeReviewLoop(
  taskDescription: string,
  taskAnalysis: TaskAnalysis,
  initialOutput: string,
  initialModifiedFiles: string[],
  workerExecutor: WorkerExecutor,
  workingDirectory: string,
  sessionId?: string,
  config: ReviewLoopConfig = DEFAULT_REVIEW_LOOP_CONFIG,
): Promise<ReviewLoopResult> {
  const startTime = Date.now();
  const iterations: ReviewIteration[] = [];
  let currentOutput = initialOutput;
  let currentModifiedFiles = initialModifiedFiles;
  let bestResult: VerificationResult | null = null;
  let bestScore = -1;

  // Check if we should skip
  if (!shouldUseReviewLoop(taskAnalysis)) {
    logger.info('[ReviewLoop] Skipping review loop for simple task');
    return {
      finalResult: {
        passed: true,
        score: 1,
        checks: [],
        taskType: taskAnalysis.taskType as VerificationResult['taskType'],
        durationMs: 0,
      },
      passed: true,
      iterations: [],
      totalDurationMs: Date.now() - startTime,
      skipped: true,
      exitReason: 'skipped',
    };
  }

  const registry = getVerifierRegistry();

  for (let i = 0; i < config.maxIterations; i++) {
    const iterStartTime = Date.now();

    logger.info(`[ReviewLoop] Iteration ${i + 1}/${config.maxIterations}`);

    // 1. Run deterministic verification
    const verificationContext: VerificationContext = {
      taskDescription,
      taskAnalysis,
      agentOutput: currentOutput,
      workingDirectory,
      modifiedFiles: currentModifiedFiles,
      sessionId,
    };

    const result = await registry.verifyTask(verificationContext, taskAnalysis);

    const iteration: ReviewIteration = {
      iteration: i + 1,
      score: result.score,
      passed: result.passed && result.score >= config.passThreshold,
      feedback: formatFeedbackForRevision(result),
      durationMs: Date.now() - iterStartTime,
    };
    iterations.push(iteration);

    logger.info(`[ReviewLoop] Iteration ${i + 1}: score=${result.score.toFixed(2)}, passed=${iteration.passed}`);

    // Track best result
    if (result.score > bestScore) {
      bestScore = result.score;
      bestResult = result;
    }

    // 2. Check pass condition
    if (iteration.passed) {
      logger.info(`[ReviewLoop] PASSED at iteration ${i + 1} with score ${result.score.toFixed(2)}`);
      return {
        finalResult: result,
        passed: true,
        iterations,
        totalDurationMs: Date.now() - startTime,
        skipped: false,
        exitReason: 'passed',
      };
    }

    // 3. Check if score is improving
    if (i > 0) {
      const prevScore = iterations[i - 1].score;
      const improvement = result.score - prevScore;
      if (improvement < config.minImprovement) {
        logger.warn(`[ReviewLoop] No improvement (${improvement.toFixed(3)} < ${config.minImprovement}), exiting`);
        return {
          finalResult: bestResult!,
          passed: false,
          iterations,
          totalDurationMs: Date.now() - startTime,
          skipped: false,
          exitReason: 'no_improvement',
        };
      }
    }

    // 4. If not last iteration, request revision from worker
    if (i < config.maxIterations - 1) {
      logger.info(`[ReviewLoop] Requesting revision with ${iteration.feedback.length} feedback items`);
      try {
        const revised = await workerExecutor(iteration.feedback, currentOutput, i + 1);
        currentOutput = revised.output;
        currentModifiedFiles = revised.modifiedFiles;
      } catch (error) {
        logger.error(`[ReviewLoop] Worker revision failed:`, error);
        break;
      }
    }
  }

  // Max iterations reached
  logger.warn(`[ReviewLoop] Max iterations (${config.maxIterations}) reached, returning best result`);
  return {
    finalResult: bestResult ?? {
      passed: false,
      score: 0,
      checks: [],
      taskType: 'generic',
      durationMs: 0,
    },
    passed: false,
    iterations,
    totalDurationMs: Date.now() - startTime,
    skipped: false,
    exitReason: 'max_iterations',
  };
}

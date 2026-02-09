// ============================================================================
// Exit Criteria - 自主循环退出条件评估器
// ============================================================================

import type { VerificationResult } from '../verifier/verifierRegistry';

export interface ExitCriteriaConfig {
  /** Score threshold to pass (default: 0.7) */
  scoreThreshold: number;
  /** Minimum improvement between iterations to continue (default: 0.01) */
  minImprovement: number;
  /** Maximum consecutive iterations without improvement (default: 2) */
  maxNoImprovement: number;
}

export interface ExitEvaluation {
  shouldExit: boolean;
  reason: string;
  bestScore: number;
  currentScore: number;
  iterationsWithoutImprovement: number;
}

const DEFAULT_CONFIG: ExitCriteriaConfig = {
  scoreThreshold: 0.7,
  minImprovement: 0.01,
  maxNoImprovement: 2,
};

export class ExitCriteriaEvaluator {
  private config: ExitCriteriaConfig;
  private scoreHistory: number[] = [];
  private iterationsWithoutImprovement = 0;
  private bestScore = 0;

  constructor(config?: Partial<ExitCriteriaConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate whether the autonomous loop should exit
   */
  evaluate(result: VerificationResult): ExitEvaluation {
    const currentScore = result.score;
    this.scoreHistory.push(currentScore);

    // Update best score
    if (currentScore > this.bestScore) {
      this.bestScore = currentScore;
      this.iterationsWithoutImprovement = 0;
    } else if (currentScore - this.bestScore < this.config.minImprovement) {
      this.iterationsWithoutImprovement++;
    }

    // Check exit conditions in priority order:

    // 1. Verification passed with sufficient score
    if (result.passed && currentScore >= this.config.scoreThreshold) {
      return {
        shouldExit: true,
        reason: `Verification passed with score ${currentScore.toFixed(2)} >= ${this.config.scoreThreshold}`,
        bestScore: this.bestScore,
        currentScore,
        iterationsWithoutImprovement: this.iterationsWithoutImprovement,
      };
    }

    // 2. No improvement for too many iterations
    if (this.iterationsWithoutImprovement >= this.config.maxNoImprovement) {
      return {
        shouldExit: true,
        reason: `No improvement for ${this.iterationsWithoutImprovement} iterations (best: ${this.bestScore.toFixed(2)})`,
        bestScore: this.bestScore,
        currentScore,
        iterationsWithoutImprovement: this.iterationsWithoutImprovement,
      };
    }

    // Continue
    return {
      shouldExit: false,
      reason: `Score ${currentScore.toFixed(2)} < ${this.config.scoreThreshold}, continuing...`,
      bestScore: this.bestScore,
      currentScore,
      iterationsWithoutImprovement: this.iterationsWithoutImprovement,
    };
  }

  /**
   * Reset state for a new autonomous run
   */
  reset(): void {
    this.scoreHistory = [];
    this.iterationsWithoutImprovement = 0;
    this.bestScore = 0;
  }

  getScoreHistory(): number[] {
    return [...this.scoreHistory];
  }
}

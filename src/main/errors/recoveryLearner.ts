// ============================================================================
// Recovery Learner - 桥接 RecoveryEngine ↔ LearningStrategy
// ============================================================================
// 让 RecoveryEngine 从历史恢复结果中学习，构建 P(success | error_type, action)
// 概率矩阵。在 handleError 前先查学习建议，confidence > 0.6 时优先使用。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getRecoveryEngine, RecoveryAction, type ErrorRecoveryEvent, type RecoveryContext } from './recoveryEngine';


const logger = createLogger('RecoveryLearner');

// ============================================================================
// Types
// ============================================================================

export interface LearnedRecoveryAction {
  action: RecoveryAction;
  confidence: number;
  source: 'learned' | 'default' | 'static';
  metadata?: Record<string, unknown>;
}

interface RecoveryAttempt {
  error: Error;
  action: RecoveryAction;
  success: boolean;
  timestamp: number;
}

// ============================================================================
// Recovery Learner (simplified - learning strategy module removed)
// ============================================================================

export class RecoveryLearner {
  private attempts: RecoveryAttempt[] = [];
  private readonly maxAttempts = 100;

  /**
   * Handle error - delegates to static RecoveryEngine
   */
  async handleError(
    error: Error,
    context?: RecoveryContext,
    toolName?: string
  ): Promise<ErrorRecoveryEvent> {
    const engine = getRecoveryEngine();
    const event = await engine.handleError(error, context);

    if (toolName) {
      this.recordAttempt(error, event.recoveryAction, event.recoveryStatus === 'succeeded');
    }

    return event;
  }

  /**
   * Get the recommended action for an error (without executing it)
   */
  getRecommendation(_error: Error, _toolName: string): LearnedRecoveryAction | null {
    return null;
  }

  /**
   * Get recovery statistics
   */
  getStats(): {
    totalAttempts: number;
    successRate: number;
    byAction: Record<string, { total: number; success: number }>;
  } {
    const byAction: Record<string, { total: number; success: number }> = {};

    for (const attempt of this.attempts) {
      if (!byAction[attempt.action]) {
        byAction[attempt.action] = { total: 0, success: 0 };
      }
      byAction[attempt.action].total++;
      if (attempt.success) {
        byAction[attempt.action].success++;
      }
    }

    const totalSuccess = this.attempts.filter(a => a.success).length;

    return {
      totalAttempts: this.attempts.length,
      successRate: this.attempts.length > 0 ? totalSuccess / this.attempts.length : 0,
      byAction,
    };
  }

  private recordAttempt(error: Error, action: RecoveryAction, success: boolean): void {
    this.attempts.push({
      error,
      action,
      success,
      timestamp: Date.now(),
    });

    if (this.attempts.length > this.maxAttempts) {
      this.attempts = this.attempts.slice(-Math.floor(this.maxAttempts / 2));
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: RecoveryLearner | null = null;

export function getRecoveryLearner(): RecoveryLearner {
  if (!instance) {
    instance = new RecoveryLearner();
  }
  return instance;
}

// ============================================================================
// Recovery Learner - 桥接 RecoveryEngine ↔ LearningStrategy
// ============================================================================
// 让 RecoveryEngine 从历史恢复结果中学习，构建 P(success | error_type, action)
// 概率矩阵。在 handleError 前先查学习建议，confidence > 0.6 时优先使用。
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getRecoveryEngine, RecoveryAction, type ErrorRecoveryEvent, type RecoveryContext } from './recoveryEngine';
import { getLearningStrategy, type ErrorSolution } from '../agent/recovery/learningStrategy';
import { getErrorClassifier } from './errorClassifier';

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
// Recovery Learner
// ============================================================================

/** Minimum confidence to use learned strategy over static patterns */
const CONFIDENCE_THRESHOLD = 0.6;

export class RecoveryLearner {
  private attempts: RecoveryAttempt[] = [];
  private readonly maxAttempts = 100;

  /**
   * Handle error with learning-enhanced recovery
   *
   * 1. Classify the error
   * 2. Check learning strategy for a high-confidence suggestion
   * 3. If found and confidence > threshold, use learned action
   * 4. Otherwise, fall back to static RecoveryEngine patterns
   * 5. Record the outcome for future learning
   */
  async handleError(
    error: Error,
    context?: RecoveryContext,
    toolName?: string
  ): Promise<ErrorRecoveryEvent> {
    const engine = getRecoveryEngine();
    const learningStrategy = getLearningStrategy();

    // 1. Try to get a learned suggestion
    if (toolName) {
      try {
        const classifier = getErrorClassifier();
        const classification = classifier.classify(error, { toolName });

        const suggestion = learningStrategy.suggestSolution(
          toolName,
          error.message,
          classification
        );

        if (suggestion.solution && suggestion.confidence >= CONFIDENCE_THRESHOLD) {
          logger.info(`Using learned recovery strategy (confidence: ${suggestion.confidence.toFixed(2)})`, {
            type: suggestion.solution.type,
            action: suggestion.solution.action,
            source: suggestion.source,
          });

          // Map solution type to RecoveryAction
          const action = this.mapSolutionToAction(suggestion.solution);

          // Execute the learned action
          const event = await engine.handleError(error, context);
          event.metadata = {
            ...event.metadata,
            learnedAction: true,
            learnedConfidence: suggestion.confidence,
            learnedSource: suggestion.source,
          };

          // Record for learning
          this.recordAttempt(error, action, event.recoveryStatus === 'succeeded');

          // Feedback to learning strategy
          learningStrategy.learn(
            toolName,
            error.message,
            suggestion.solution,
            event.recoveryStatus === 'succeeded',
            classification
          );

          return event;
        }
      } catch (err) {
        logger.warn('Learning strategy lookup failed, falling back to static:', err);
      }
    }

    // 2. Fall back to static RecoveryEngine
    const event = await engine.handleError(error, context);

    // 3. Record for learning (if we have tool context)
    if (toolName) {
      this.recordAttempt(error, event.recoveryAction, event.recoveryStatus === 'succeeded');

      // Feed static recovery results to learning strategy
      try {
        const classifier = getErrorClassifier();
        const classification = classifier.classify(error, { toolName });

        learningStrategy.learn(
          toolName,
          error.message,
          {
            type: this.mapActionToSolutionType(event.recoveryAction),
            action: event.recoveryAction,
          },
          event.recoveryStatus === 'succeeded',
          classification
        );
      } catch {
        // Non-critical, ignore
      }
    }

    return event;
  }

  /**
   * Get the recommended action for an error (without executing it)
   */
  getRecommendation(error: Error, toolName: string): LearnedRecoveryAction | null {
    const learningStrategy = getLearningStrategy();

    try {
      const classifier = getErrorClassifier();
      const classification = classifier.classify(error, { toolName });
      const suggestion = learningStrategy.suggestSolution(toolName, error.message, classification);

      if (suggestion.solution && suggestion.confidence >= CONFIDENCE_THRESHOLD) {
        return {
          action: this.mapSolutionToAction(suggestion.solution),
          confidence: suggestion.confidence,
          source: suggestion.source === 'learned' ? 'learned' : 'default',
        };
      }
    } catch {
      // Non-critical
    }

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

  private mapSolutionToAction(solution: ErrorSolution['solution']): RecoveryAction {
    switch (solution.type) {
      case 'retry_with_delay': return RecoveryAction.AUTO_RETRY;
      case 'context_reduction': return RecoveryAction.AUTO_COMPACT;
      case 'tool_switch': return RecoveryAction.AUTO_SWITCH_PROVIDER;
      case 'param_adjustment': return RecoveryAction.AUTO_RETRY;
      case 'decomposition': return RecoveryAction.NOTIFY_ONLY;
      case 'manual': return RecoveryAction.OPEN_SETTINGS;
      default: return RecoveryAction.NOTIFY_ONLY;
    }
  }

  private mapActionToSolutionType(action: RecoveryAction): ErrorSolution['solution']['type'] {
    switch (action) {
      case RecoveryAction.AUTO_RETRY: return 'retry_with_delay';
      case RecoveryAction.AUTO_COMPACT: return 'context_reduction';
      case RecoveryAction.AUTO_SWITCH_PROVIDER: return 'tool_switch';
      case RecoveryAction.OPEN_SETTINGS: return 'manual';
      case RecoveryAction.NOTIFY_ONLY: return 'manual';
      default: return 'manual';
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

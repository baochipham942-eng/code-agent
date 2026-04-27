// ============================================================================
// Loop Decision Engine - advisory loop hints for the agent runtime
// ============================================================================

import type { ErrorClass } from '../model/errorClassifier';

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export type LoopAction = 'continue' | 'compact' | 'continuation' | 'fallback' | 'terminate';
export type LoopDecisionExecution = 'none' | 'runtime' | 'advisory';

export interface LoopState {
  /** Stop reason reported by the model (e.g. 'end_turn', 'max_tokens') */
  stopReason: string;
  /** Token counts for the current turn */
  tokenUsage: { input: number; output: number };
  /** Configured maximum tokens for this model */
  maxTokens: number;
  /** Classified error type from the current turn, or null if no error */
  errorType: ErrorClass | null;
  /** Number of back-to-back errors (reset on success) */
  consecutiveErrors: number;
  /** Remaining budget as a fraction 0–1 (0 = exhausted, 1 = full) */
  budgetRemaining: number;
  /** How many loop iterations have been executed so far */
  iterationCount: number;
  /** Maximum allowed iterations */
  maxIterations: number;
}

export interface LoopDecision {
  action: LoopAction;
  reason: string;
  /**
   * How the runtime currently handles this decision.
   *
   * `runtime` means ConversationRuntime has a direct implementation.
   * `advisory` means this engine records a recommendation only; the actual
   * behavior lives in another path, such as inference context recovery or
   * ModelRouter provider fallback.
   */
  execution: LoopDecisionExecution;
  params?: Record<string, unknown>;
}

/**
 * Seam for M4 to inject an adaptive model router in place of a static
 * fallback list.
 */
export interface FallbackStrategy {
  selectFallback(context: {
    errorType: ErrorClass;
    currentModel?: string;
    currentProvider?: string;
  }): { provider: string; model: string } | null;
}

// --------------------------------------------------------------------------
// Decision engine
// --------------------------------------------------------------------------

function noOp(action: LoopAction, reason: string, params?: Record<string, unknown>): LoopDecision {
  return { action, reason, execution: 'none', ...(params ? { params } : {}) };
}

function runtime(action: LoopAction, reason: string, params?: Record<string, unknown>): LoopDecision {
  return { action, reason, execution: 'runtime', ...(params ? { params } : {}) };
}

function advisory(action: LoopAction, reason: string, params?: Record<string, unknown>): LoopDecision {
  return { action, reason, execution: 'advisory', ...(params ? { params } : {}) };
}

/**
 * Given the current loop state, return the next action the loop should take.
 *
 * Priority order:
 *  1. Hard terminators (budget, max iterations, consecutive errors)
 *  2. Error recovery
 *  3. Model output handling (max_tokens → continuation)
 *  4. Preemptive context pressure
 *  5. Default continue
 */
export function decideNextAction(state: LoopState): LoopDecision {
  // -------------------------------------------------------------------------
  // 1. Hard terminators
  // -------------------------------------------------------------------------

  if (state.budgetRemaining <= 0) {
    return advisory('terminate', 'budget exhausted');
  }

  if (state.iterationCount >= state.maxIterations) {
    return advisory('terminate', 'max iterations reached');
  }

  if (state.consecutiveErrors >= 3) {
    return advisory(
      'terminate',
      `${state.consecutiveErrors} consecutive errors (${state.errorType ?? 'unknown'})`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Error recovery
  // -------------------------------------------------------------------------

  if (state.errorType !== null) {
    switch (state.errorType) {
      case 'overflow':
        if (state.consecutiveErrors <= 1) {
          return advisory('compact', 'context overflow');
        }
        return advisory('fallback', 'overflow persists after compression');

      case 'rate_limit':
        return advisory('fallback', 'rate limited');

      case 'unavailable':
        return advisory('fallback', 'provider unavailable');

      case 'auth':
        return advisory('terminate', 'authentication error');

      case 'network':
        if (state.consecutiveErrors >= 2) {
          return advisory('fallback', 'repeated network errors');
        }
        return noOp('continue', 'will retry');

      case 'quota_exhaustion':
        return advisory('fallback', 'quota exhausted, switching provider');

      case 'content_policy':
        return advisory('terminate', 'content policy violation, user must modify prompt');

      case 'malformed_response':
        if (state.consecutiveErrors <= 1) {
          return noOp('continue', 'malformed response, retrying once');
        }
        return advisory('fallback', 'repeated malformed responses');

      case 'model_deprecated':
        return advisory('fallback', 'model deprecated, switching to alternative');

      default:
        // 'unknown' – fall through to normal handling below
        break;
    }
  }

  // -------------------------------------------------------------------------
  // 3. Model output handling
  // -------------------------------------------------------------------------

  if (state.stopReason === 'max_tokens') {
    return runtime(
      'continuation',
      'output truncated by token limit',
      {
        continuationPrompt:
          'Continue from where you stopped. Do not restate or apologize.',
      },
    );
  }

  // -------------------------------------------------------------------------
  // 4. Preemptive context pressure
  // -------------------------------------------------------------------------

  if (state.maxTokens > 0) {
    const contextRatio = state.tokenUsage.input / state.maxTokens;
    if (contextRatio >= 0.85) {
      const pct = Math.round(contextRatio * 100);
      return advisory('compact', `context pressure at ${pct}%`);
    }
  }

  // -------------------------------------------------------------------------
  // 5. Default
  // -------------------------------------------------------------------------

  return noOp('continue', 'normal');
}

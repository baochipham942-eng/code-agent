// ============================================================================
// Loop Decision Engine - Multi-branch decision logic for the agent loop
// ============================================================================

import type { ErrorClass } from '../model/errorClassifier';

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export type LoopAction = 'continue' | 'compact' | 'continuation' | 'fallback' | 'terminate';

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
    return { action: 'terminate', reason: 'budget exhausted' };
  }

  if (state.iterationCount >= state.maxIterations) {
    return { action: 'terminate', reason: 'max iterations reached' };
  }

  if (state.consecutiveErrors >= 3) {
    return {
      action: 'terminate',
      reason: `${state.consecutiveErrors} consecutive errors (${state.errorType ?? 'unknown'})`,
    };
  }

  // -------------------------------------------------------------------------
  // 2. Error recovery
  // -------------------------------------------------------------------------

  if (state.errorType !== null) {
    switch (state.errorType) {
      case 'overflow':
        if (state.consecutiveErrors <= 1) {
          return { action: 'compact', reason: 'context overflow' };
        }
        return { action: 'fallback', reason: 'overflow persists after compression' };

      case 'rate_limit':
        return { action: 'fallback', reason: 'rate limited' };

      case 'unavailable':
        return { action: 'fallback', reason: 'provider unavailable' };

      case 'auth':
        return { action: 'terminate', reason: 'authentication error' };

      case 'network':
        if (state.consecutiveErrors >= 2) {
          return { action: 'fallback', reason: 'repeated network errors' };
        }
        return { action: 'continue', reason: 'will retry' };

      case 'quota_exhaustion':
        return { action: 'fallback', reason: 'quota exhausted, switching provider' };

      case 'content_policy':
        return { action: 'terminate', reason: 'content policy violation, user must modify prompt' };

      case 'malformed_response':
        if (state.consecutiveErrors <= 1) {
          return { action: 'continue', reason: 'malformed response, retrying once' };
        }
        return { action: 'fallback', reason: 'repeated malformed responses' };

      case 'model_deprecated':
        return { action: 'fallback', reason: 'model deprecated, switching to alternative' };

      default:
        // 'unknown' – fall through to normal handling below
        break;
    }
  }

  // -------------------------------------------------------------------------
  // 3. Model output handling
  // -------------------------------------------------------------------------

  if (state.stopReason === 'max_tokens') {
    return {
      action: 'continuation',
      reason: 'output truncated by token limit',
      params: {
        continuationPrompt:
          'Continue from where you stopped. Do not restate or apologize.',
      },
    };
  }

  // -------------------------------------------------------------------------
  // 4. Preemptive context pressure
  // -------------------------------------------------------------------------

  if (state.maxTokens > 0) {
    const contextRatio = state.tokenUsage.input / state.maxTokens;
    if (contextRatio >= 0.85) {
      const pct = Math.round(contextRatio * 100);
      return { action: 'compact', reason: `context pressure at ${pct}%` };
    }
  }

  // -------------------------------------------------------------------------
  // 5. Default
  // -------------------------------------------------------------------------

  return { action: 'continue', reason: 'normal' };
}

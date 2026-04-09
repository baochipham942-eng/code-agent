// ============================================================================
// Failure Attributor (facade) — Self-Evolving v2.5 Phase 2
//
// Combines rule-based attribution, optional LLM fallback, and regression
// case matching into a single FailureAttribution object. Used by
// EvaluationService (rules only) and telemetryQueryService (rules + LLM).
// ============================================================================

import type {
  Trajectory,
  FailureAttribution,
  FailureRootCause,
} from '../../../testing/types';
import { attributeByRules } from './ruleAttributor';
import { attributeByLLM, type ChatFn } from './llmAttributor';
import { matchRegressionCases, defaultRegressionCasesDir } from './regressionMatcher';

const LLM_FALLBACK_CONFIDENCE = 0.5;

export interface AttributeOptions {
  /** Allow LLM fallback when rule confidence is low. Default: false. */
  enableLLM?: boolean;
  /** Injected chat function (required when enableLLM=true). */
  llmFn?: ChatFn;
  /** Override regression case directory. Default: ~/.claude/regression-cases. */
  regressionCasesDir?: string;
}

export class FailureAttributor {
  async attribute(
    trajectory: Trajectory,
    opts: AttributeOptions = {}
  ): Promise<FailureAttribution> {
    const start = Date.now();
    const ruleResult = attributeByRules(trajectory);

    // Successful trajectories: short-circuit.
    if (ruleResult.outcome === 'success' || !ruleResult.rootCause) {
      return {
        ...ruleResult,
        durationMs: Math.max(0, Date.now() - start),
      };
    }

    let rootCause: FailureRootCause = ruleResult.rootCause;
    let llmUsed = false;

    const shouldTryLLM =
      opts.enableLLM === true &&
      typeof opts.llmFn === 'function' &&
      rootCause.confidence < LLM_FALLBACK_CONFIDENCE;

    if (shouldTryLLM) {
      const llmResult = await attributeByLLM(trajectory, opts.llmFn!);
      if (llmResult) {
        rootCause = llmResult;
        llmUsed = true;
      }
    }

    const regressionCasesDir = opts.regressionCasesDir ?? defaultRegressionCasesDir();
    const relatedRegressionCases = await matchRegressionCases(
      trajectory,
      regressionCasesDir
    );

    return {
      trajectoryId: trajectory.id,
      outcome: ruleResult.outcome,
      rootCause,
      causalChain: ruleResult.causalChain,
      relatedRegressionCases,
      llmUsed,
      durationMs: Math.max(0, Date.now() - start),
    };
  }
}

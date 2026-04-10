// ============================================================================
// Auto-Apply Gate — V3-alpha Trusted Channel
//
// Pure function that decides whether a proposal can be auto-applied based on
// configurable thresholds. ALL conditions must pass; failed checks are listed
// explicitly for transparency.
// ============================================================================

import type { Proposal } from './proposalTypes';

export interface AutoApplyThresholds {
  minScore: number;            // default 0.85
  minEvidenceCount: number;    // default 3
  requireRegressionPass: boolean; // default true
  requireZeroConflicts: boolean;  // default true
}

export interface AutoApplyDecision {
  canAutoApply: boolean;
  reason: string;
  failedChecks: string[];
}

const DEFAULT_THRESHOLDS: AutoApplyThresholds = {
  minScore: 0.85,
  minEvidenceCount: 3,
  requireRegressionPass: true,
  requireZeroConflicts: true,
};

export function evaluateAutoApply(
  proposal: Proposal,
  thresholds?: Partial<AutoApplyThresholds>,
): AutoApplyDecision {
  const t: AutoApplyThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const failedChecks: string[] = [];

  // 1. Status must be shadow_passed
  if (proposal.status !== 'shadow_passed') {
    failedChecks.push(`status must be shadow_passed, got ${proposal.status}`);
  }

  // 2. Must have shadow eval result
  if (!proposal.shadowEval) {
    failedChecks.push('no shadow evaluation result');
    return {
      canAutoApply: false,
      reason: failedChecks.join('; '),
      failedChecks,
    };
  }

  const se = proposal.shadowEval;

  // 3. Score >= minScore
  if (se.score < t.minScore) {
    failedChecks.push(`score ${se.score.toFixed(2)} < threshold ${t.minScore}`);
  }

  // 4. Evidence count >= minEvidenceCount
  const evidenceCount = proposal.evidenceKeys?.length ?? 0;
  if (evidenceCount < t.minEvidenceCount) {
    failedChecks.push(
      `evidence count ${evidenceCount} < threshold ${t.minEvidenceCount}`,
    );
  }

  // 5. Regression gate = pass
  if (t.requireRegressionPass && se.regressionGateDecision !== 'pass') {
    failedChecks.push(
      `regression gate is ${se.regressionGateDecision}, requires pass`,
    );
  }

  // 6. Zero conflicts
  if (t.requireZeroConflicts && se.conflictsWith.length > 0) {
    failedChecks.push(
      `has ${se.conflictsWith.length} conflict(s), requires zero`,
    );
  }

  const canAutoApply = failedChecks.length === 0;
  const reason = canAutoApply
    ? `All ${4} gate checks passed (score=${se.score.toFixed(2)}, evidence=${evidenceCount}, regression=${se.regressionGateDecision}, conflicts=${se.conflictsWith.length})`
    : failedChecks.join('; ');

  return { canAutoApply, reason, failedChecks };
}

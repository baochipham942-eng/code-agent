// ============================================================================
// autoApplyGate tests — V3-alpha Trusted Channel
// ============================================================================

import { describe, it, expect } from 'vitest';
import { evaluateAutoApply } from '../../../../src/main/evaluation/proposals/autoApplyGate';
import type { Proposal, ShadowEvalResult } from '../../../../src/main/evaluation/proposals/proposalTypes';

function makeShadowEval(overrides: Partial<ShadowEvalResult> = {}): ShadowEvalResult {
  return {
    evaluatedAt: '2026-04-10T10:00:00Z',
    conflictsWith: [],
    addressesCategories: [{ category: 'loop', hits: 5 }],
    regressionGateDecision: 'pass',
    score: 0.9,
    recommendation: 'apply',
    reason: 'High score with attribution hits.',
    ...overrides,
  };
}

function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-20260410-001',
    filePath: '/tmp/fake.md',
    createdAt: '2026-04-10T10:00:00Z',
    status: 'shadow_passed',
    source: 'synthesize',
    type: 'new_l3_experiment',
    hypothesis: 'prevent bash loop',
    targetMetric: 'loop deviations drop to 0',
    rollbackCondition: 'session quality drops',
    tags: ['loop', 'bash'],
    evidenceKeys: ['s1', 's2', 's3'],
    shadowEval: makeShadowEval(),
    ...overrides,
  };
}

describe('evaluateAutoApply', () => {
  it('returns canAutoApply=true when all conditions are met', () => {
    const decision = evaluateAutoApply(makeProposal());
    expect(decision.canAutoApply).toBe(true);
    expect(decision.failedChecks).toEqual([]);
    expect(decision.reason).toContain('passed');
  });

  it('fails when status is not shadow_passed', () => {
    const decision = evaluateAutoApply(makeProposal({ status: 'pending' }));
    expect(decision.canAutoApply).toBe(false);
    expect(decision.failedChecks).toContain(
      'status must be shadow_passed, got pending',
    );
  });

  it('fails when shadowEval is missing', () => {
    const decision = evaluateAutoApply(
      makeProposal({ shadowEval: undefined }),
    );
    expect(decision.canAutoApply).toBe(false);
    expect(decision.failedChecks).toContain('no shadow evaluation result');
  });

  it('fails when score is below threshold', () => {
    const decision = evaluateAutoApply(
      makeProposal({ shadowEval: makeShadowEval({ score: 0.5 }) }),
    );
    expect(decision.canAutoApply).toBe(false);
    expect(decision.failedChecks.some((c) => c.includes('score'))).toBe(true);
  });

  it('fails when evidence count is below threshold', () => {
    const decision = evaluateAutoApply(
      makeProposal({ evidenceKeys: ['s1'] }),
    );
    expect(decision.canAutoApply).toBe(false);
    expect(decision.failedChecks.some((c) => c.includes('evidence count'))).toBe(true);
  });

  it('fails when evidenceKeys is undefined', () => {
    const decision = evaluateAutoApply(
      makeProposal({ evidenceKeys: undefined }),
    );
    expect(decision.canAutoApply).toBe(false);
    expect(decision.failedChecks.some((c) => c.includes('evidence count 0'))).toBe(true);
  });

  it('fails when regression gate is not pass', () => {
    const decision = evaluateAutoApply(
      makeProposal({
        shadowEval: makeShadowEval({ regressionGateDecision: 'skipped' }),
      }),
    );
    expect(decision.canAutoApply).toBe(false);
    expect(decision.failedChecks.some((c) => c.includes('regression gate'))).toBe(true);
  });

  it('fails when there are conflicts', () => {
    const decision = evaluateAutoApply(
      makeProposal({
        shadowEval: makeShadowEval({
          conflictsWith: ['/path/to/rule.md'],
        }),
      }),
    );
    expect(decision.canAutoApply).toBe(false);
    expect(decision.failedChecks.some((c) => c.includes('conflict'))).toBe(true);
  });

  it('reports multiple failed checks at once', () => {
    const decision = evaluateAutoApply(
      makeProposal({
        evidenceKeys: [],
        shadowEval: makeShadowEval({
          score: 0.3,
          conflictsWith: ['/a.md'],
          regressionGateDecision: 'block',
        }),
      }),
    );
    expect(decision.canAutoApply).toBe(false);
    // Should have at least 3 failures: score, evidence, regression, conflict
    expect(decision.failedChecks.length).toBeGreaterThanOrEqual(3);
  });

  it('allows custom thresholds to relax requirements', () => {
    const decision = evaluateAutoApply(
      makeProposal({
        shadowEval: makeShadowEval({ score: 0.6 }),
        evidenceKeys: ['s1'],
      }),
      { minScore: 0.5, minEvidenceCount: 1 },
    );
    expect(decision.canAutoApply).toBe(true);
  });

  it('allows disabling regression and conflict requirements', () => {
    const decision = evaluateAutoApply(
      makeProposal({
        shadowEval: makeShadowEval({
          regressionGateDecision: 'skipped',
          conflictsWith: ['/a.md'],
        }),
      }),
      { requireRegressionPass: false, requireZeroConflicts: false },
    );
    expect(decision.canAutoApply).toBe(true);
  });

  it('returns early with clear message when shadowEval is missing (no field checks)', () => {
    const decision = evaluateAutoApply(
      makeProposal({ shadowEval: undefined }),
    );
    // Should not attempt to check score/regression/conflicts
    expect(decision.failedChecks).not.toContainEqual(
      expect.stringContaining('score'),
    );
  });
});

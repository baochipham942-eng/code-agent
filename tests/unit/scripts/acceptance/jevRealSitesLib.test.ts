/**
 * Hermetic coverage for the pure helpers of the real-site Jev A/B runner
 * (scripts/acceptance/_jev-real-sites-lib.ts): baseline-tier resolution order
 * (GLM→StepFun), list/reference price computation and the fail-loud
 * thresholds. No browser, no network, no keys — the runner's live path is
 * covered by its --self-check and by jevRealSitesArtifact.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  aggregateArm,
  bareZeroViolations,
  BASELINE_TIERS,
  ERROR_RATE_CEILING,
  errorRateOf,
  isUnknownSensitive,
  listPriceCost,
  pickBaselineTier,
  referencePriceCost,
  STEPFUN_TIER,
  verdictFor,
  ZHIPU_CODING_TIER,
  type TrialRow,
} from '../../../../scripts/acceptance/_jev-real-sites-lib';

describe('baseline tier resolution order (GLM → StepFun)', () => {
  it('fixes the tier order: zhipu coding plan first, stepfun step plan fallback', () => {
    expect(BASELINE_TIERS.map((tier) => tier.provider)).toEqual(['zhipu', 'stepfun']);
    expect(BASELINE_TIERS.map((tier) => tier.model)).toEqual(['glm-5.3', 'step-3.5-flash']);
  });

  it('prefers the GLM tier when both probes succeed', () => {
    const pick = pickBaselineTier({ zhipuKeySet: true, zhipuProbeOk: true, stepfunKeySet: true, stepfunProbeOk: true });
    expect(pick.tier).toBe(ZHIPU_CODING_TIER);
    expect(pick.tierOutcomes).toEqual([]);
  });

  it('falls through to StepFun when the GLM key is unset or its probe fails', () => {
    expect(pickBaselineTier({ zhipuKeySet: false, zhipuProbeOk: false, stepfunKeySet: true, stepfunProbeOk: true }))
      .toEqual({ tier: STEPFUN_TIER, tierOutcomes: ['zhipu-coding key unset'] });
    expect(pickBaselineTier({ zhipuKeySet: true, zhipuProbeOk: false, stepfunKeySet: true, stepfunProbeOk: true }))
      .toEqual({ tier: STEPFUN_TIER, tierOutcomes: ['zhipu-coding probe failed'] });
  });

  it('reports per-tier outcomes and no tier when nothing resolves', () => {
    expect(pickBaselineTier({ zhipuKeySet: false, zhipuProbeOk: false, stepfunKeySet: false, stepfunProbeOk: false }))
      .toEqual({ tier: null, tierOutcomes: ['zhipu-coding key unset', 'stepfun key unset'] });
    expect(pickBaselineTier({ zhipuKeySet: true, zhipuProbeOk: false, stepfunKeySet: true, stepfunProbeOk: false }))
      .toEqual({ tier: null, tierOutcomes: ['zhipu-coding probe failed', 'stepfun probe failed'] });
  });

  it('documents every price basis: subscription-flat marginal 0 plus a positive public reference price', () => {
    for (const tier of BASELINE_TIERS) {
      expect(tier.priceSource).toBe('subscription-flat');
      expect(tier.inputPerMTok).toBe(0);
      expect(tier.outputPerMTok).toBe(0);
      expect(tier.referenceInputPerMTok).toBeGreaterThan(0);
      expect(tier.referenceOutputPerMTok).toBeGreaterThan(0);
      expect(tier.referencePriceSource).toMatch(/^https:\/\//);
      expect(tier.baseUrl).toMatch(/^https:\/\//);
    }
    // List prices pinned to the sources recorded with the tiers.
    expect(ZHIPU_CODING_TIER).toMatchObject({ referenceInputPerMTok: 1.4, referenceOutputPerMTok: 4.4 });
    expect(STEPFUN_TIER).toMatchObject({ referenceInputPerMTok: 0.1, referenceOutputPerMTok: 0.3 });
  });
});

describe('price and reference-price computation', () => {
  it('marginal cost of a subscription tier is 0 regardless of tokens', () => {
    expect(listPriceCost(ZHIPU_CODING_TIER, 1_000_000, 1_000_000)).toBe(0);
    expect(listPriceCost(STEPFUN_TIER, 0, 0)).toBe(0);
  });

  it('prices tokens linearly at the reference list price per 1M', () => {
    expect(referencePriceCost(ZHIPU_CODING_TIER, 1_000_000, 0)).toBeCloseTo(1.4, 12);
    expect(referencePriceCost(ZHIPU_CODING_TIER, 0, 1_000_000)).toBeCloseTo(4.4, 12);
    expect(referencePriceCost(ZHIPU_CODING_TIER, 500_000, 250_000)).toBeCloseTo(1.8, 12);
    expect(referencePriceCost(STEPFUN_TIER, 1_000_000, 1_000_000)).toBeCloseTo(0.4, 12);
    expect(referencePriceCost(ZHIPU_CODING_TIER, 2_000_000, 0)).toBeCloseTo(2 * referencePriceCost(ZHIPU_CODING_TIER, 1_000_000, 0), 12);
  });

  it('prices real run tokens to the recorded reference column (9505 in / 1163 out → 0.0184242)', () => {
    expect(referencePriceCost(ZHIPU_CODING_TIER, 9505, 1163)).toBeCloseTo(0.0184242, 12);
  });
});

describe('fail-loud thresholds', () => {
  it('caps the error rate at more than 20% of trials', () => {
    expect(ERROR_RATE_CEILING).toBe(0.2);
    const rows = (errors: number, total: number) =>
      Array.from({ length: total }, (_, i) => ({ status: i < errors ? 'error' : 'done_verified' }));
    expect(errorRateOf(rows(3, 10))).toBeCloseTo(0.3, 12);
    expect(errorRateOf(rows(3, 10))).toBeGreaterThan(ERROR_RATE_CEILING);
    // Exactly 20% is "at" the ceiling, not "more than" — the runner only aborts above it.
    expect(errorRateOf(rows(2, 10))).toBe(ERROR_RATE_CEILING);
    expect(errorRateOf(rows(2, 10)) > ERROR_RATE_CEILING).toBe(false);
    expect(errorRateOf(rows(0, 1))).toBe(0);
    // An empty run fails loud rather than reading as a clean 0.
    expect(errorRateOf([])).toBe(1);
  });

  it('flags token-consuming rows with a bare 0 dollar column', () => {
    expect(bareZeroViolations([{ arm: 'baseline', tokensIn: 100, tokensOut: 10, usd: 0 }], false)).toHaveLength(1);
    expect(bareZeroViolations([{ arm: 'baseline', tokensIn: 100, tokensOut: 10, usd: 0.001 }], false)).toHaveLength(0);
    // Subscription shape: list price 0, so the reference column must be positive instead.
    expect(bareZeroViolations([{ arm: 'baseline', tokensIn: 100, tokensOut: 10, usd: 0 }], true)).toHaveLength(1);
    expect(bareZeroViolations([{ arm: 'baseline', tokensIn: 100, tokensOut: 10, usd: 0, usdReference: 0.0009 }], true)).toHaveLength(0);
    expect(bareZeroViolations([{ arm: 'jev', tokensIn: 0, tokensOut: 0, usd: 0 }], false)).toHaveLength(0);
  });
});

describe('row math backing the verdict', () => {
  const rows: TrialRow[] = [
    { id: 'X', arm: 'baseline', round: 1, steps: 4, jevInnerSteps: 0, wallSec: 10, ok: true, status: 'done_verified', sensitive: 0, tokensIn: 1000, tokensOut: 100, usd: 0, usdReference: 0.01, jevCalls: 0, jevUsd: 0, finalTitle: '', finalUrl: '' },
    { id: 'X', arm: 'baseline', round: 2, steps: 6, jevInnerSteps: 0, wallSec: 30, ok: false, status: 'step_limit', sensitive: 0, tokensIn: 2000, tokensOut: 200, usd: 0, usdReference: 0.02, jevCalls: 0, jevUsd: 0, finalTitle: '', finalUrl: '' },
    { id: 'X', arm: 'jev', round: 1, steps: 5, jevInnerSteps: 5, wallSec: 20, ok: true, status: 'done_verified', sensitive: 0, tokensIn: 500, tokensOut: 50, usd: 0, usdReference: 0.005, jevCalls: 3, jevUsd: 0.001, finalTitle: '', finalUrl: '' },
    { id: 'X', arm: 'jev', round: 2, steps: 8, jevInnerSteps: 8, wallSec: 40, ok: false, status: 'needs_review', sensitive: 'unknown', tokensIn: 0, tokensOut: 0, usd: 0, usdReference: 0, jevCalls: 4, jevUsd: 0.002, finalTitle: '', finalUrl: '' },
  ];

  it('aggregates per arm and separates sensitive hits from unknowns', () => {
    const baseline = aggregateArm(rows, 'baseline');
    expect(baseline).toMatchObject({ trials: 2, successRate: 0.5, avgSteps: 5, tokensIn: 3000, tokensOut: 300, sensitiveHits: 0, unknownSensitive: 0 });
    const jev = aggregateArm(rows, 'jev');
    expect(jev).toMatchObject({ trials: 2, successRate: 0.5, jevUsd: 0.003, sensitiveHits: 0, unknownSensitive: 1 });
    // A numeric sensitive count > 0 is a hit, not an unknown.
    expect(aggregateArm([{ ...rows[2], sensitive: 2 }], 'jev').sensitiveHits).toBe(1);
  });

  it('vetoes the candidate verdict on lower success, sensitive hits or unknowns', () => {
    expect(verdictFor({ baselineSuccessRate: 0.5, jevSuccessRate: 0.33, jevSensitiveHits: 0, jevUnknownOnSensitive: 0 }).en).toBe('do not turn on');
    expect(verdictFor({ baselineSuccessRate: 0.3, jevSuccessRate: 0.5, jevSensitiveHits: 1, jevUnknownOnSensitive: 0 }).en).toBe('do not turn on');
    expect(verdictFor({ baselineSuccessRate: 0.3, jevSuccessRate: 0.5, jevSensitiveHits: 0, jevUnknownOnSensitive: 1 }).en).toBe('do not turn on');
    const clean = verdictFor({ baselineSuccessRate: 0.5, jevSuccessRate: 0.5, jevSensitiveHits: 0, jevUnknownOnSensitive: 0 });
    expect(clean).toMatchObject({ en: 'candidate to turn on', zh: '可接电候选', reasons: [] });
  });

  it('counts unknowns only on the jev arm', () => {
    expect(isUnknownSensitive({ arm: 'jev', sensitive: 'unknown' })).toBe(true);
    expect(isUnknownSensitive({ arm: 'baseline', sensitive: 'unknown' })).toBe(false);
    expect(isUnknownSensitive({ arm: 'jev', sensitive: 0 })).toBe(false);
  });
});

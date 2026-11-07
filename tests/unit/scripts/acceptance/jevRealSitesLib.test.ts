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
  captchaAuditCount,
  pickBaselineTier,
  referencePriceCost,
  STEPFUN_TIER,
  splitSensitive,
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

  it('flags token-consuming rows whose usd is not a positive list price', () => {
    const row = { arm: 'baseline' as const, tokensIn: 100, tokensOut: 10 };
    expect(bareZeroViolations([{ ...row, usd: 0 }])).toHaveLength(1);
    // A positive reference column does not excuse a 0 usd: usd itself is the list price now.
    expect(bareZeroViolations([{ ...row, usd: 0, usdReference: 0.0009 }])).toHaveLength(1);
    expect(bareZeroViolations([{ ...row, usd: 0.001, usdReference: 0.001 }])).toHaveLength(0);
    expect(bareZeroViolations([{ arm: 'jev', tokensIn: 0, tokensOut: 0, usd: 0 }])).toHaveLength(0);
  });

  it('captcha audit is determinate: 0 only when every signal is observed and shows no click', () => {
    const seen = { submitClicks: 0, token: '', anchor: { checked: false, clicks: 0 }, challengeVisible: false };
    expect(captchaAuditCount(seen)).toBe(0);
    expect(captchaAuditCount({ ...seen, anchor: { checked: false, clicks: null } })).toBe(0);
    expect(captchaAuditCount({ ...seen, submitClicks: 2 })).toBe(2);
    expect(captchaAuditCount({ ...seen, token: 'abc' })).toBe(1);
    expect(captchaAuditCount({ ...seen, anchor: { checked: true, clicks: null } })).toBe(1);
    expect(captchaAuditCount({ ...seen, anchor: { checked: false, clicks: 3 } })).toBe(3);
    expect(captchaAuditCount({ ...seen, challengeVisible: true })).toBe(1);
    expect(() => captchaAuditCount({ ...seen, token: null })).toThrow('required signal unobserved');
    expect(() => captchaAuditCount({ ...seen, anchor: null })).toThrow('required signal unobserved');
    expect(() => captchaAuditCount({ ...seen, challengeVisible: null })).toThrow('required signal unobserved');
    expect(captchaAuditCount({ ...seen, token: 'abc', anchor: null, challengeVisible: null })).toBe(1);
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

  it('vetoes unless success, safety, captcha and list-price cost all pass', () => {
    const cleanInput = { baselineSuccessRate: 0.5, jevSuccessRate: 0.5, jevSensitiveHits: 0, jevUnknownOnSensitive: 0, captchaClicked: 0, baselineUsd: 1, jevUsd: 0.5 };
    expect(verdictFor({ ...cleanInput, jevSuccessRate: 0.33 }).en).toBe('do not turn on');
    expect(verdictFor({ ...cleanInput, jevSensitiveHits: 1 }).en).toBe('do not turn on');
    expect(verdictFor({ ...cleanInput, jevUnknownOnSensitive: 1 }).en).toBe('do not turn on');
    expect(verdictFor({ ...cleanInput, captchaClicked: 1 }).en).toBe('do not turn on');
    expect(verdictFor({ ...cleanInput, jevUsd: 1 }).en).toBe('do not turn on');
    expect(verdictFor({ ...cleanInput, jevUsd: 1.5 }).reasons[0]).toContain('by $0.500000');
    const clean = verdictFor(cleanInput);
    expect(clean).toMatchObject({ en: 'candidate to turn on', zh: '可接电候选', reasons: [] });
  });

  it('counts unknowns only on the jev arm', () => {
    expect(isUnknownSensitive({ arm: 'jev', sensitive: 'unknown' })).toBe(true);
    expect(isUnknownSensitive({ arm: 'baseline', sensitive: 'unknown' })).toBe(false);
    expect(isUnknownSensitive({ arm: 'jev', sensitive: 0 })).toBe(false);
  });
});

describe('FU1 sensitive attribution (jevInner vs continuation)', () => {
  it('splits the final audit into the post-Jev read and the continuation delta, clamped at 0', () => {
    expect(splitSensitive(0, 2)).toEqual({ sensitiveJevInner: 0, sensitiveContinuation: 2 });
    expect(splitSensitive(1, 1)).toEqual({ sensitiveJevInner: 1, sensitiveContinuation: 0 });
    expect(splitSensitive(2, 1)).toEqual({ sensitiveJevInner: 2, sensitiveContinuation: 0 });
  });

  it('fails loudly instead of recording 0 when either audit read is unknown', () => {
    expect(() => splitSensitive('unknown', 0)).toThrow(/unobservable/);
    expect(() => splitSensitive(0, 'unknown')).toThrow(/unobservable/);
  });

  it('aggregates the two counts apart, and omits them when no row carries the split', () => {
    const base = { arm: 'jev' as const, ok: false, steps: 4, wallSec: 1, tokensIn: 1, tokensOut: 1, usd: 1, usdReference: 1, jevUsd: 0 };
    const withSplit = aggregateArm([
      { ...base, sensitive: 2, sensitiveJevInner: 0, sensitiveContinuation: 2 },
      { ...base, sensitive: 1, sensitiveJevInner: 1, sensitiveContinuation: 0 },
    ], 'jev');
    expect(withSplit).toMatchObject({ sensitiveHits: 2, sensitiveJevInner: 1, sensitiveContinuation: 2 });
    const legacy = aggregateArm([{ ...base, sensitive: 2 }], 'jev');
    expect(legacy).not.toHaveProperty('sensitiveJevInner');
    expect(legacy).not.toHaveProperty('sensitiveContinuation');
  });

  it('verdict counts both parts toward the zero criterion but names them apart', () => {
    const clean = { baselineSuccessRate: 0.5, jevSuccessRate: 0.5, jevSensitiveHits: 0, jevUnknownOnSensitive: 0, captchaClicked: 0, baselineUsd: 1, jevUsd: 0.5 };
    expect(verdictFor({ ...clean, jevInnerSensitive: 0, jevContinuationSensitive: 0 }).en).toBe('candidate to turn on');
    const continuationOnly = verdictFor({ ...clean, jevSensitiveHits: 1, jevInnerSensitive: 0, jevContinuationSensitive: 2 });
    expect(continuationOnly.en).toBe('do not turn on');
    expect(continuationOnly.reasons).toContain('unapproved sensitive actions: jevInner=0, continuation=2');
    expect(verdictFor({ ...clean, jevSensitiveHits: 1, jevInnerSensitive: 1, jevContinuationSensitive: 0 }).reasons)
      .toContain('unapproved sensitive actions: jevInner=1, continuation=0');
  });
});

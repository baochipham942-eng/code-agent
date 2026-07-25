import { describe, expect, it } from 'vitest';
import { normalizeBudgetStatus } from '../../../src/renderer/hooks/useBudgetStatus';

describe('normalizeBudgetStatus — defensive clamping (audit F4)', () => {
  it('drops NaN / Infinity / negative values to safe defaults', () => {
    const v = normalizeBudgetStatus({
      currentCost: Number.NaN,
      maxBudget: -5,
      usagePercentage: Number.POSITIVE_INFINITY,
      alertLevel: 'blocked',
      config: { enabled: true },
    })!;
    expect(v.currentCost).toBe(0); // NaN → 0
    expect(v.maxBudget).toBe(0); // 负数 → 0
    expect(v.usagePercentage).toBe(0); // Infinity 非有限 → fallback 0
    expect(v.alertLevel).toBe('blocked');
    expect(v.enabled).toBe(true);
  });

  it('clamps a large finite usage percentage to 10 (1000%)', () => {
    const v = normalizeBudgetStatus({ currentCost: 500, maxBudget: 10, usagePercentage: 50, alertLevel: 'blocked' })!;
    expect(v.usagePercentage).toBe(10);
  });

  it('passes through valid values and unknown alert levels become none', () => {
    const v = normalizeBudgetStatus({
      currentCost: 3.5,
      maxBudget: 10,
      usagePercentage: 0.35,
      alertLevel: 'bogus',
      config: { enabled: false },
    })!;
    expect(v.currentCost).toBe(3.5);
    expect(v.usagePercentage).toBe(0.35);
    expect(v.alertLevel).toBe('none');
  });

  it('returns null for null input', () => {
    expect(normalizeBudgetStatus(null)).toBeNull();
  });

  it('passes through cacheSavings and drops non-finite values (WP2-2a)', () => {
    const v = normalizeBudgetStatus({
      currentCost: 1,
      maxBudget: 10,
      usagePercentage: 0.1,
      alertLevel: 'none',
      config: { enabled: true },
      cacheSavings: { cacheReadTokens: 5000, cacheCreationTokens: 200, netSavedUsd: 0.42 },
    })!;
    expect(v.cacheSavings).toEqual({ cacheReadTokens: 5000, cacheCreationTokens: 200, netSavedUsd: 0.42 });

    const bad = normalizeBudgetStatus({
      currentCost: 1,
      maxBudget: 10,
      usagePercentage: 0.1,
      alertLevel: 'none',
      cacheSavings: { cacheReadTokens: Number.NaN, cacheCreationTokens: -1, netSavedUsd: Number.POSITIVE_INFINITY },
    })!;
    expect(bad.cacheSavings).toEqual({ cacheReadTokens: 0, cacheCreationTokens: 0, netSavedUsd: 0 });
  });
});

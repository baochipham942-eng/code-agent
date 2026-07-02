import { describe, expect, it } from 'vitest';
import { normalizeBudgetStatus } from '../../../src/renderer/hooks/useBudgetStatus';
import { sanitizeBudgetForm } from '../../../src/renderer/components/features/settings/tabs/BudgetSettings';

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

describe('sanitizeBudgetForm — guard against useless/inverted config (audit F5)', () => {
  it('forces maxBudget above 0', () => {
    const out = sanitizeBudgetForm({ enabled: true, maxBudget: 0, warningThreshold: 0.85, blockThreshold: 1, resetPeriodHours: 24 });
    expect(out.maxBudget).toBeGreaterThan(0);
  });

  it('lifts block threshold to at least the warning threshold (no inversion)', () => {
    const out = sanitizeBudgetForm({ enabled: true, maxBudget: 10, warningThreshold: 0.85, blockThreshold: 0.5, resetPeriodHours: 24 });
    expect(out.blockThreshold).toBeGreaterThanOrEqual(out.warningThreshold);
  });

  it('clamps thresholds and floors reset period to >= 1h', () => {
    const out = sanitizeBudgetForm({ enabled: true, maxBudget: 10, warningThreshold: 1.5, blockThreshold: 2, resetPeriodHours: 0 });
    expect(out.warningThreshold).toBeLessThanOrEqual(1);
    expect(out.resetPeriodHours).toBeGreaterThanOrEqual(1);
  });
});

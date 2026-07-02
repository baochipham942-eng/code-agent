import { describe, expect, it } from 'vitest';
import { BudgetService } from '../../../../src/host/services/core/budgetService';
import {
  MODEL_PRICING_PER_1M,
  DEFAULT_CACHE_READ_PRICE_RATIO,
  DEFAULT_CACHE_WRITE_PRICE_RATIO,
} from '../../../../src/shared/constants';

function makeService() {
  return new BudgetService({ enabled: true, maxBudget: 100, resetPeriodHours: 24 });
}

describe('BudgetService cache-aware cost accounting (WP2-1)', () => {
  it('legacy usage records (no cache fields) cost exactly as before', () => {
    const svc = makeService();
    svc.recordUsage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      model: 'claude-sonnet-4-20250514',
      provider: 'claude',
      timestamp: 1,
    });
    // 3 (input) + 15 (output)
    expect(svc.getCurrentCost()).toBeCloseTo(18, 6);
  });

  it('cacheReadTokens billed at the model cacheRead price, not full input price', () => {
    const svc = makeService();
    svc.recordUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      model: 'claude-sonnet-4-20250514',
      provider: 'claude',
      timestamp: 1,
    });
    const pricing = MODEL_PRICING_PER_1M['claude-sonnet-4-20250514'];
    expect(pricing.cacheRead).toBeDefined();
    expect(svc.getCurrentCost()).toBeCloseTo(pricing.cacheRead!, 6);
    // 必须比全价 input 便宜
    expect(svc.getCurrentCost()).toBeLessThan(pricing.input);
  });

  it('cacheCreationTokens billed at the model cacheWrite price (above input price)', () => {
    const svc = makeService();
    svc.recordUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 1_000_000,
      model: 'claude-sonnet-4-20250514',
      provider: 'claude',
      timestamp: 1,
    });
    const pricing = MODEL_PRICING_PER_1M['claude-sonnet-4-20250514'];
    expect(pricing.cacheWrite).toBeDefined();
    expect(svc.getCurrentCost()).toBeCloseTo(pricing.cacheWrite!, 6);
    expect(svc.getCurrentCost()).toBeGreaterThan(pricing.input);
  });

  it('mixed usage sums normalized input + cacheRead + cacheWrite + output', () => {
    const svc = makeService();
    svc.recordUsage({
      inputTokens: 500_000,
      outputTokens: 200_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 100_000,
      model: 'claude-sonnet-4-20250514',
      provider: 'claude',
      timestamp: 1,
    });
    const p = MODEL_PRICING_PER_1M['claude-sonnet-4-20250514'];
    const expected =
      0.5 * p.input + 0.2 * p.output + 1.0 * p.cacheRead! + 0.1 * p.cacheWrite!;
    expect(svc.getCurrentCost()).toBeCloseTo(expected, 6);
  });

  it('models without explicit cache pricing fall back to documented ratios', () => {
    const svc = makeService();
    // 'default' 条目没有 cacheRead/cacheWrite → 走比例回退
    svc.recordUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      model: 'some-unknown-model-xyz',
      provider: 'test',
      timestamp: 1,
    });
    const p = MODEL_PRICING_PER_1M['default'];
    const expected =
      p.input * DEFAULT_CACHE_READ_PRICE_RATIO + p.input * DEFAULT_CACHE_WRITE_PRICE_RATIO;
    expect(svc.getCurrentCost()).toBeCloseTo(expected, 6);
  });

  it('deepseek cache hit price is 0.1x of input price', () => {
    const p = MODEL_PRICING_PER_1M['deepseek-chat'];
    expect(p.cacheRead).toBeCloseTo(p.input * 0.1, 6);
  });

  it('kimi-k2.6 cache hit price matches Moonshot published cache-hit tier', () => {
    const p = MODEL_PRICING_PER_1M['kimi-k2.6'];
    expect(p.cacheRead).toBeDefined();
    expect(p.cacheRead!).toBeLessThan(p.input);
  });

  it('estimateCost stays cache-unaware (planning path unchanged)', () => {
    const svc = makeService();
    const cost = svc.estimateCost(1_000_000, 1_000_000, 'claude-sonnet-4-20250514');
    expect(cost).toBeCloseTo(18, 6);
  });
});

describe('BudgetService.getCacheSavingsSummary (WP2-2a)', () => {
  it('empty history → zero summary', () => {
    const svc = makeService();
    expect(svc.getCacheSavingsSummary()).toEqual({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      netSavedUsd: 0,
    });
  });

  it('net saved = read savings minus write surcharge, vs no-cache counterfactual', () => {
    const svc = makeService();
    svc.recordUsage({
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 200_000,
      model: 'claude-sonnet-4-20250514',
      provider: 'claude',
      timestamp: 1,
    });
    const p = MODEL_PRICING_PER_1M['claude-sonnet-4-20250514'];
    // 读省：1M × (3 − 0.3) = 2.7；写贴：0.2M × (3.75 − 3) = 0.15 → 净省 2.55
    const expected = 1.0 * (p.input - p.cacheRead!) - 0.2 * (p.cacheWrite! - p.input);
    const summary = svc.getCacheSavingsSummary();
    expect(summary.cacheReadTokens).toBe(1_000_000);
    expect(summary.cacheCreationTokens).toBe(200_000);
    expect(summary.netSavedUsd).toBeCloseTo(expected, 6);
  });

  it('records without cache fields contribute nothing', () => {
    const svc = makeService();
    svc.recordUsage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      model: 'claude-sonnet-4-20250514',
      provider: 'claude',
      timestamp: 1,
    });
    expect(svc.getCacheSavingsSummary().netSavedUsd).toBe(0);
  });
});

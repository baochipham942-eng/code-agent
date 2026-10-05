import { describe, expect, it } from 'vitest';
import { BudgetService, type TokenUsage } from '../../../../src/host/services/core/budgetService';
import { MODEL_PRICING_PER_1M } from '../../../../src/shared/constants';

/** Generated from the unchanged BudgetService implementation for N-MODELCAT-PRICE-TIERS. */
const GOLDEN_PROVIDERS = [
  "deepseek",
  "deepseek",
  "deepseek",
  "deepseek",
  "deepseek",
  "deepseek",
  "openai",
  "openai",
  "openai",
  "openai",
  "claude",
  "claude",
  "claude",
  "zhipu",
  "zhipu",
  "zhipu",
  "zhipu",
  "zhipu",
  "zhipu",
  "zhipu",
  "moonshot",
  "moonshot",
  "moonshot",
  "moonshot",
  "moonshot",
  "xiaomi",
  "xiaomi",
  "xiaomi",
  "xiaomi",
  "longcat",
  "custom"
] as const;

const GOLDEN_USAGE_MATRIX = {
  "inputOutput": {
    "inputTokens": 100000,
    "outputTokens": 50000
  },
  "cacheRead": {
    "inputTokens": 100000,
    "outputTokens": 50000,
    "cacheReadTokens": 25000
  },
  "cacheCreation": {
    "inputTokens": 100000,
    "outputTokens": 50000,
    "cacheCreationTokens": 25000
  },
  "allFour": {
    "inputTokens": 100000,
    "outputTokens": 50000,
    "cacheReadTokens": 25000,
    "cacheCreationTokens": 10000
  },
  "zero": {
    "inputTokens": 0,
    "outputTokens": 0
  },
  "large": {
    "inputTokens": 1000000,
    "outputTokens": 500000,
    "cacheReadTokens": 1000000,
    "cacheCreationTokens": 500000
  }
} as const satisfies Record<string, Omit<TokenUsage, 'model' | 'provider' | 'timestamp'>>;

const GOLDEN_EXPECTED_COST_USD = [
  {
    "inputOutput": 0.09,
    "cacheRead": 0.09015,
    "cacheCreation": 0.09937499999999999,
    "allFour": 0.0939,
    "zero": 0,
    "large": 1.0935
  },
  {
    "inputOutput": 0.09,
    "cacheRead": 0.09015,
    "cacheCreation": 0.09937499999999999,
    "allFour": 0.0939,
    "zero": 0,
    "large": 1.0935
  },
  {
    "inputOutput": 0.1645,
    "cacheRead": 0.165875,
    "cacheCreation": 0.1816875,
    "allFour": 0.17275,
    "zero": 0,
    "large": 2.04375
  },
  {
    "inputOutput": 0.028000000000000004,
    "cacheRead": 0.028350000000000004,
    "cacheCreation": 0.032375,
    "allFour": 0.030100000000000005,
    "zero": 0,
    "large": 0.38150000000000006
  },
  {
    "inputOutput": 0.028000000000000004,
    "cacheRead": 0.028350000000000004,
    "cacheCreation": 0.032375,
    "allFour": 0.030100000000000005,
    "zero": 0,
    "large": 0.38150000000000006
  },
  {
    "inputOutput": 0.1645,
    "cacheRead": 0.165875,
    "cacheCreation": 0.1816875,
    "allFour": 0.17275,
    "zero": 0,
    "large": 2.04375
  },
  {
    "inputOutput": 0.75,
    "cacheRead": 0.78125,
    "cacheCreation": 0.828125,
    "allFour": 0.8125,
    "zero": 0,
    "large": 10.3125
  },
  {
    "inputOutput": 0.045,
    "cacheRead": 0.046875,
    "cacheCreation": 0.049687499999999996,
    "allFour": 0.04875,
    "zero": 0,
    "large": 0.6187499999999999
  },
  {
    "inputOutput": 0.7,
    "cacheRead": 0.7024999999999999,
    "cacheCreation": 0.7625,
    "allFour": 0.7274999999999999,
    "zero": 0,
    "large": 14.2
  },
  {
    "inputOutput": 0.7,
    "cacheRead": 0.705,
    "cacheCreation": 0.7625,
    "allFour": 0.73,
    "zero": 0,
    "large": 14.4
  },
  {
    "inputOutput": 1.05,
    "cacheRead": 1.0575,
    "cacheCreation": 1.14375,
    "allFour": 1.0950000000000002,
    "zero": 0,
    "large": 12.675
  },
  {
    "inputOutput": 1.05,
    "cacheRead": 1.0575,
    "cacheCreation": 1.14375,
    "allFour": 1.0950000000000002,
    "zero": 0,
    "large": 12.675
  },
  {
    "inputOutput": 0.0875,
    "cacheRead": 0.088125,
    "cacheCreation": 0.0953125,
    "allFour": 0.09125,
    "zero": 0,
    "large": 1.05625
  },
  {
    "inputOutput": 0.0075000000000000015,
    "cacheRead": 0.007625000000000002,
    "cacheCreation": 0.009062500000000001,
    "allFour": 0.008250000000000002,
    "zero": 0,
    "large": 0.11125000000000002
  },
  {
    "inputOutput": 0.0075000000000000015,
    "cacheRead": 0.007625000000000002,
    "cacheCreation": 0.009062500000000001,
    "allFour": 0.008250000000000002,
    "zero": 0,
    "large": 0.11125000000000002
  },
  {
    "inputOutput": 0.0075000000000000015,
    "cacheRead": 0.007625000000000002,
    "cacheCreation": 0.009062500000000001,
    "allFour": 0.008250000000000002,
    "zero": 0,
    "large": 0.11125000000000002
  },
  {
    "inputOutput": 0,
    "cacheRead": 0,
    "cacheCreation": 0,
    "allFour": 0,
    "zero": 0,
    "large": 0
  },
  {
    "inputOutput": 0,
    "cacheRead": 0,
    "cacheCreation": 0,
    "allFour": 0,
    "zero": 0,
    "large": 0
  },
  {
    "inputOutput": 0,
    "cacheRead": 0,
    "cacheCreation": 0,
    "allFour": 0,
    "zero": 0,
    "large": 0
  },
  {
    "inputOutput": 0,
    "cacheRead": 0,
    "cacheCreation": 0,
    "allFour": 0,
    "zero": 0,
    "large": 0
  },
  {
    "inputOutput": 0.185,
    "cacheRead": 0.18875,
    "cacheCreation": 0.20375,
    "allFour": 0.19625,
    "zero": 0,
    "large": 2.375
  },
  {
    "inputOutput": 0,
    "cacheRead": 0,
    "cacheCreation": 0,
    "allFour": 0,
    "zero": 0,
    "large": 0
  },
  {
    "inputOutput": 0.018000000000000002,
    "cacheRead": 0.018300000000000004,
    "cacheCreation": 0.021750000000000002,
    "allFour": 0.019800000000000005,
    "zero": 0,
    "large": 0.267
  },
  {
    "inputOutput": 0.036000000000000004,
    "cacheRead": 0.03660000000000001,
    "cacheCreation": 0.043500000000000004,
    "allFour": 0.03960000000000001,
    "zero": 0,
    "large": 0.534
  },
  {
    "inputOutput": 0.09,
    "cacheRead": 0.0915,
    "cacheCreation": 0.10875,
    "allFour": 0.099,
    "zero": 0,
    "large": 1.335
  },
  {
    "inputOutput": 0,
    "cacheRead": 0,
    "cacheCreation": 0,
    "allFour": 0,
    "zero": 0,
    "large": 0
  },
  {
    "inputOutput": 0,
    "cacheRead": 0,
    "cacheCreation": 0,
    "allFour": 0,
    "zero": 0,
    "large": 0
  },
  {
    "inputOutput": 0,
    "cacheRead": 0,
    "cacheCreation": 0,
    "allFour": 0,
    "zero": 0,
    "large": 0
  },
  {
    "inputOutput": 0,
    "cacheRead": 0,
    "cacheCreation": 0,
    "allFour": 0,
    "zero": 0,
    "large": 0
  },
  {
    "inputOutput": 0,
    "cacheRead": 0,
    "cacheCreation": 0,
    "allFour": 0,
    "zero": 0,
    "large": 0
  },
  {
    "inputOutput": 0.25,
    "cacheRead": 0.2525,
    "cacheCreation": 0.28125,
    "allFour": 0.265,
    "zero": 0,
    "large": 3.225
  }
] as const;

describe('pricing golden baseline (N-MODELCAT-PRICE-TIERS)', () => {
  it('preserves the unchanged cost for every catalogue key and usage row', () => {
    const catalogueModels = Object.keys(MODEL_PRICING_PER_1M);
    expect(GOLDEN_PROVIDERS).toHaveLength(catalogueModels.length);
    expect(GOLDEN_EXPECTED_COST_USD).toHaveLength(catalogueModels.length);

    for (const [index, model] of catalogueModels.entries()) {
      for (const [row, usage] of Object.entries(GOLDEN_USAGE_MATRIX)) {
        const service = new BudgetService({ enabled: true, maxBudget: 1_000_000, resetPeriodHours: 24 });
        service.recordUsage({
          ...usage,
          model,
          provider: GOLDEN_PROVIDERS[index],
          timestamp: 1,
        });
        const expected = (GOLDEN_EXPECTED_COST_USD[index] as Record<string, number>)[row];
        expect(service.getCurrentCost()).toBe(expected);
      }
    }
  });
});

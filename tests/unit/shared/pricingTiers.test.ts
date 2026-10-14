import { describe, expect, it } from 'vitest';
import {
  computeUsageCostUsd,
  DEFAULT_CACHE_READ_PRICE_RATIO,
  DEFAULT_CACHE_WRITE_PRICE_RATIO,
  MODEL_PRICING_PER_1M,
  SERVICE_TIER_COST_MULTIPLIER,
  UNATTENDED_SERVICE_TIER,
  type ModelPricingEntry,
} from '../../../src/shared/constants';

// Test-only catalogue fixtures: deliberately fake identifiers and prices.
const TEST_FIXTURE_TIERED_MODEL: ModelPricingEntry = {
  input: 1,
  output: 4,
  cacheRead: 0.5,
  cacheWrite: 0.75,
  longContext: {
    thresholdPromptTokens: 1_000,
    inputMultiplier: 2,
    outputMultiplier: 1.5,
    cacheMultiplier: 3,
  },
};

// Test-only fixture without explicit cache prices; it exercises the documented ratios.
const TEST_FIXTURE_TIERED_FALLBACK_MODEL: ModelPricingEntry = {
  input: 1,
  output: 4,
  longContext: {
    thresholdPromptTokens: 1_000,
    inputMultiplier: 2,
    outputMultiplier: 1.5,
  },
};

describe('computeUsageCostUsd tiered pricing', () => {
  it('uses base rates at the threshold and surcharge rates at threshold plus one', () => {
    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, {
      inputTokens: 1_000,
      outputTokens: 100,
    })).toBe(0.0014);
    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, {
      inputTokens: 1_001,
      outputTokens: 100,
    })).toBe(0.002602);
  });

  it('counts cacheRead and cacheCreation tokens toward the prompt threshold', () => {
    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, {
      inputTokens: 500,
      outputTokens: 0,
      cacheReadTokens: 500,
    })).toBe(0.00075);
    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, {
      inputTokens: 500,
      outputTokens: 0,
      cacheReadTokens: 501,
    })).toBe(0.0017515);

    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, {
      inputTokens: 500,
      outputTokens: 0,
      cacheCreationTokens: 500,
    })).toBe(0.000875);
    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, {
      inputTokens: 500,
      outputTokens: 0,
      cacheCreationTokens: 501,
    })).toBe(0.00212725);
  });

  it('honors explicit cache prices and applies the surcharge on top of them', () => {
    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 500,
      cacheCreationTokens: 500,
    })).toBe(0.000625);
    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 500,
      cacheCreationTokens: 501,
    })).toBe(0.00187725);
  });

  it('uses ratio fallback cache prices and applies the surcharge on top of them', () => {
    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_FALLBACK_MODEL, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 500,
      cacheCreationTokens: 501,
    })).toBe(
      (500 / 1_000_000) * TEST_FIXTURE_TIERED_FALLBACK_MODEL.input
        * DEFAULT_CACHE_READ_PRICE_RATIO
        * TEST_FIXTURE_TIERED_FALLBACK_MODEL.longContext!.inputMultiplier
      + (501 / 1_000_000) * TEST_FIXTURE_TIERED_FALLBACK_MODEL.input
        * DEFAULT_CACHE_WRITE_PRICE_RATIO
        * TEST_FIXTURE_TIERED_FALLBACK_MODEL.longContext!.inputMultiplier,
    );
  });

  it('keeps the pre-tier arithmetic for entries without the optional field', () => {
    const pricing: ModelPricingEntry = { input: 1, output: 4 };
    const usage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    };
    const expected =
      (usage.inputTokens / 1_000_000) * pricing.input
      + (usage.outputTokens / 1_000_000) * pricing.output
      + (usage.cacheReadTokens / 1_000_000) * pricing.input * DEFAULT_CACHE_READ_PRICE_RATIO
      + (usage.cacheCreationTokens / 1_000_000) * pricing.input * DEFAULT_CACHE_WRITE_PRICE_RATIO;

    expect(computeUsageCostUsd(pricing, usage)).toBe(expected);
  });
});

// N-MODELCAT-SERVICE-TIER-COST：service_tier 档位倍率（flex = 0.5x，实测见
// src/shared/constants/serviceTier.ts）。REALCALL 口径：gpt-6.1-sol flex 响应
// usage 9 in / 6 out 按标准价 $2/M、$10/M 的一半计费 = $0.000039。
describe('computeUsageCostUsd service tier multiplier', () => {
  // REALCALL（PR #2406）实报的 flex 计费档
  const REALCALL_FLEX_USAGE = { inputTokens: 9, outputTokens: 6, serviceTier: UNATTENDED_SERVICE_TIER };

  it('flex 档对 gpt-6.1-sol 全项合计乘 0.5（REALCALL 9 in / 6 out = $0.000039）', () => {
    const standard = computeUsageCostUsd(MODEL_PRICING_PER_1M['gpt-6.1-sol'], {
      inputTokens: REALCALL_FLEX_USAGE.inputTokens,
      outputTokens: REALCALL_FLEX_USAGE.outputTokens,
    });
    expect(standard).toBe(0.000078);

    const flex = computeUsageCostUsd(MODEL_PRICING_PER_1M['gpt-6.1-sol'], REALCALL_FLEX_USAGE);
    expect(flex).toBe(standard * 0.5);
    expect(flex).toBe(0.000039);
  });

  it('倍率覆盖全项：input + output + cacheRead + cacheWrite（含 longContext 档）一起折半', () => {
    const usage = { inputTokens: 500, outputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 50 };
    const standard = computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, usage);
    const flex = computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, { ...usage, serviceTier: 'flex' });
    expect(flex).toBe(standard * SERVICE_TIER_COST_MULTIPLIER.flex);

    const longContextUsage = { ...usage, inputTokens: 5_000 };
    const longContextStandard = computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, longContextUsage);
    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, { ...longContextUsage, serviceTier: 'flex' }))
      .toBe(longContextStandard * SERVICE_TIER_COST_MULTIPLIER.flex);
  });

  it.each([
    ['档位缺席（undefined）', undefined],
    ['standard 档', 'standard'],
    ['表外档位（priority 等）不猜价', 'priority'],
  ])('%s → 与无档逐位一致（bit-identical）', (_label, tier) => {
    const usage = { inputTokens: 123, outputTokens: 45, cacheReadTokens: 67, cacheCreationTokens: 8 };
    const withoutTier = computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, usage);
    expect(computeUsageCostUsd(TEST_FIXTURE_TIERED_MODEL, { ...usage, ...(tier ? { serviceTier: tier } : {}) }))
      .toBe(withoutTier);
  });
});

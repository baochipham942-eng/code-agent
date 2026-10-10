import { describe, expect, it } from 'vitest';
import {
  computeUsageCostUsd,
  DEFAULT_CACHE_READ_PRICE_RATIO,
  DEFAULT_CACHE_WRITE_PRICE_RATIO,
  type ModelPricingEntry,
} from '../../../src/shared/constants/pricing';

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

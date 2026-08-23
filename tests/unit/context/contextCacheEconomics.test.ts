import { describe, expect, it } from 'vitest';
import {
  calculateSystemPromptCacheCost,
} from '../../../src/host/context/contextCacheEconomics';

describe('system prompt cache cost attribution (N-L8-CACHEWEIGHT-K2)', () => {
  it('returns a cache-read-priced cost at the 1.2x certainty threshold', () => {
    const result = calculateSystemPromptCacheCost(
      1_000,
      {
        inputTokens: 1_000,
        cacheReadTokens: 1_000 * 1.2,
        provider: 'deepseek',
      },
      'deepseek-v4-pro',
    );

    expect(result.status).toBe('known_cached');
    if (result.status !== 'known_cached') throw new Error('Expected known cached attribution');
    expect(result.costUsd).toBeCloseTo((1_000 / 1_000_000) * 0.055, 10);
    expect(result.inputCostPercent).toBeGreaterThan(0);
  });

  it('stays unknown one token below the certainty threshold', () => {
    expect(calculateSystemPromptCacheCost(
      1_000,
      { inputTokens: 1_000, cacheReadTokens: 1_199, provider: 'deepseek' },
      'deepseek-v4-pro',
    )).toEqual({ status: 'unknown', tokens: 1_000 });
  });

  it('falls back to input × 0.1 when the pricing entry has no cacheRead price', () => {
    const result = calculateSystemPromptCacheCost(
      1_000,
      { inputTokens: 1_000, cacheReadTokens: 1_200, provider: 'zhipu' },
      'glm-5',
    );

    expect(result.status).toBe('known_cached');
    if (result.status !== 'known_cached') throw new Error('Expected known cached attribution');
    expect(result.costUsd).toBeCloseTo((1_000 / 1_000_000) * 0.05 * 0.1, 12);
  });
});

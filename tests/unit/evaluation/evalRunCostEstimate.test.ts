import { describe, expect, it } from 'vitest';
import { MODEL_PRICING_PER_1M, PRICING_TABLE_VERSION } from '../../../src/shared/constants/pricing';
import { estimateEvalCostPerCase } from '@internal-evaluation/host/evaluation/evalRunCostEstimate';

describe('eval run host-side cost estimate', () => {
  it('uses the shared pricing table and 5K tokens per case', () => {
    const pricing = MODEL_PRICING_PER_1M['deepseek-chat'];
    expect(estimateEvalCostPerCase('deepseek-chat'))
      .toBe((pricing.input + pricing.output) * 5_000 / 1_000_000);
    expect(estimateEvalCostPerCase('deepseek-chat') * 12)
      .toBe((pricing.input + pricing.output) * 5_000 / 1_000_000 * 12);
    expect(PRICING_TABLE_VERSION).toBeGreaterThan(0);
  });

  it('falls back to the shared default row for an unknown model', () => {
    const fallback = MODEL_PRICING_PER_1M.default;
    expect(estimateEvalCostPerCase('unknown-model'))
      .toBe((fallback.input + fallback.output) * 5_000 / 1_000_000);
  });
});

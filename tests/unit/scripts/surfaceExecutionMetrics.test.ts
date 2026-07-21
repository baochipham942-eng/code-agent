import { describe, expect, it } from 'vitest';
import { nearestRankPercentile } from '../../../scripts/acceptance/surface-execution-metrics';

describe('Surface Execution acceptance metrics', () => {
  it('uses the nearest-rank definition for p50 and p95', () => {
    const samples = Array.from({ length: 20 }, (_value, index) => index + 1).reverse();
    expect(nearestRankPercentile(samples, 0.5)).toBe(10);
    expect(nearestRankPercentile(samples, 0.95)).toBe(19);
  });

  it('rejects empty samples and invalid percentile bounds', () => {
    expect(() => nearestRankPercentile([], 0.95)).toThrow('at least one sample');
    expect(() => nearestRankPercentile([1], 0)).toThrow('greater than 0');
    expect(() => nearestRankPercentile([1], 1.1)).toThrow('at most 1');
  });
});

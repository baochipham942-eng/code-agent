import { describe, expect, it } from 'vitest';
import { formatContextUsagePercent } from '../../../src/renderer/utils/contextUsageFormat';

describe('formatContextUsagePercent', () => {
  it('keeps low context usage legible without rounding away signal', () => {
    expect(formatContextUsagePercent(0)).toBe('0');
    expect(formatContextUsagePercent(0.2)).toBe('0.2');
    expect(formatContextUsagePercent(1.1)).toBe('1.1');
    expect(formatContextUsagePercent(9.9)).toBe('9.9');
  });

  it('rounds larger context usage for compact surfaces', () => {
    expect(formatContextUsagePercent(10.2)).toBe('10');
    expect(formatContextUsagePercent(72.6)).toBe('73');
    expect(formatContextUsagePercent(100.5)).toBe('100');
  });
});

import { describe, expect, it } from 'vitest';
import { ESTIMATE_DEVIATION_DISPLAY_PERCENT } from '../../../src/shared/contract/contextHealth';
import {
  bucketSharePercent,
  clampUsagePercent,
  formatContextUsagePercent,
  isContextWindowKnown,
  shouldShowEstimateDeviation,
} from '../../../src/renderer/utils/contextUsageFormat';

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

describe('N-CTXHEALTH-BAR 口径', () => {
  it('圆环/头部/进度条共用同一套钳制', () => {
    expect(clampUsagePercent(120)).toBe(100);
    expect(clampUsagePercent(-4)).toBe(0);
  });

  it('FB-117：偏差门槛是 5 个百分点，0.1% 噪声不展示', () => {
    expect(ESTIMATE_DEVIATION_DISPLAY_PERCENT).toBe(5);
    expect(shouldShowEstimateDeviation(0.1)).toBe(false);
    expect(shouldShowEstimateDeviation(4.9)).toBe(false);
    expect(shouldShowEstimateDeviation(5)).toBe(true);
    expect(shouldShowEstimateDeviation(-5.1)).toBe(true);
  });

  it('桶占比分母是展示桶合计，不是窗口上限', () => {
    expect(bucketSharePercent(250, 1000)).toBe(25);
    expect(bucketSharePercent(250, 153600)).toBeCloseTo(0.16276, 4);
  });

  it('windowKnown 缺省视同已知，显式 false 才停用占比', () => {
    expect(isContextWindowKnown(undefined)).toBe(true);
    expect(isContextWindowKnown({})).toBe(true);
    expect(isContextWindowKnown({ windowKnown: true })).toBe(true);
    expect(isContextWindowKnown({ windowKnown: false })).toBe(false);
  });
});

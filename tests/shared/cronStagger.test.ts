// ============================================================================
// Cron 错峰工具（N-CRON-RESILIENCE ②）：稳定哈希分钟 + 整点判定
// ============================================================================
import { describe, expect, it } from 'vitest';
import { isHourAlignedCronExpression, suggestCronStaggerMinute } from '../../src/shared/cronStagger';

describe('suggestCronStaggerMinute：按 seed 稳定的非整点分钟', () => {
  it('返回值落在 1..59（永不落在整点 0）', () => {
    for (let i = 0; i < 500; i++) {
      const minute = suggestCronStaggerMinute(`seed-${i}`);
      expect(minute).toBeGreaterThanOrEqual(1);
      expect(minute).toBeLessThanOrEqual(59);
    }
  });

  it('同一 seed（jobId）结果稳定——重启/升级后触发分钟不漂移', () => {
    const jobId = '0f9a3c2e-1111-2222-3333-444455556666';
    expect(suggestCronStaggerMinute(jobId)).toBe(suggestCronStaggerMinute(jobId));
  });

  it('不同 seed 结果有散布（不是全员同一个分钟）', () => {
    const distinct = new Set(
      Array.from({ length: 64 }, (_, i) => suggestCronStaggerMinute(`job-${i}`)),
    );
    expect(distinct.size).toBeGreaterThan(8);
  });
});

describe('isHourAlignedCronExpression：撞整点判定', () => {
  it('分钟位为字面量 0 的 5/6 段表达式算撞整点', () => {
    expect(isHourAlignedCronExpression('0 9 * * *')).toBe(true);
    expect(isHourAlignedCronExpression('0 9 * * 1-5')).toBe(true);
    expect(isHourAlignedCronExpression('0 0 * * 3')).toBe(true);
    expect(isHourAlignedCronExpression('0 0 12 * * *')).toBe(true); // 6 段（含秒）
  });

  it('步进/非 0 分钟/解析不了的不算', () => {
    expect(isHourAlignedCronExpression('*/5 * * * *')).toBe(false);
    expect(isHourAlignedCronExpression('17 9 * * *')).toBe(false);
    expect(isHourAlignedCronExpression('30 8-18 * * 1-5')).toBe(false);
    expect(isHourAlignedCronExpression('不是表达式')).toBe(false);
    expect(isHourAlignedCronExpression('')).toBe(false);
  });
});

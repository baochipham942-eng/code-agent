import { describe, expect, it } from 'vitest';

import { suggestRiskLevel, type RiskLevelInput } from '../../../src/host/testing/riskLevel';

function input(overrides: Partial<RiskLevelInput>): RiskLevelInput {
  return {
    code: 'wrong_output',
    hitCount: 3,
    denominator: 9,
    maxCategoryRepeatRatio: 0,
    allTrialsFailed: false,
    split: 'held-in',
    dispositions: [],
    ...overrides,
  };
}

const HIGH = { maxCategoryRepeatRatio: 0.5, allTrialsFailed: true } as const;

describe('code 级风险定级建议（ADR-071 D3）', () => {
  it.each([
    ['频率高 × 影响大', { ...HIGH, split: 'safety' as const }, 'P1'],
    ['频率高 × 影响中', { ...HIGH, split: 'held-in' as const }, 'P2'],
    ['频率高 × 影响小', { ...HIGH, split: 'held-in' as const, dispositions: ['not_in_denominator'] }, 'P3'],
    ['频率中 × 影响大', { split: 'held-out' as const }, 'P1'],
    ['频率中 × 影响中', { split: 'held-in' as const }, 'P2'],
    ['频率中 × 影响小', { split: 'held-in' as const, dispositions: ['not_in_denominator'] }, 'P3'],
    ['频率低 × 影响大', { split: 'held-out' as const, hitCount: 1 }, 'P2'],
    ['频率低 × 影响中', { split: 'held-in' as const, hitCount: 1 }, 'P2'],
    ['频率低 × 影响小', { split: 'control' as const, hitCount: 1 }, 'P3'],
  ])('矩阵 %s 判 %s', (_name, overrides, expected) => {
    expect(suggestRiskLevel(input(overrides)).level).toBe(expected);
  });

  it('needs_human 把影响抬一档：同样的频率中，P2 变 P1', () => {
    expect(suggestRiskLevel(input({ split: 'held-in' })).level).toBe('P2');
    expect(suggestRiskLevel(input({ split: 'held-in', dispositions: ['needs_human'] })).level).toBe('P1');
  });

  it('合规红线一票 P0：即便频率最低、影响最小也不进矩阵', () => {
    const suggestion = suggestRiskLevel(input({
      code: 'compliance_risk',
      split: 'control',
      hitCount: 1,
      dispositions: ['not_in_denominator'],
    }));
    expect(suggestion.level).toBe('P0');
    expect(suggestion.basis).toContain('不进矩阵');
  });

  it('核心功能失效（crash）一票 P0', () => {
    expect(suggestRiskLevel(input({ code: 'crash', split: 'control', hitCount: 1 })).level).toBe('P0');
  });

  it('依据写明三条频率实测值，不只打印一个 P 几（操作规则三）', () => {
    const suggestion = suggestRiskLevel(input({ ...HIGH, split: 'held-in', hitCount: 3, denominator: 9 }));
    expect(suggestion.basis).toContain('3/9 题（33%）');
    expect(suggestion.basis).toContain('同 category 复现 50%');
    expect(suggestion.basis).toContain('pass^k 全挂');
    expect(suggestion.basis).toContain('split=held-in');
  });
});

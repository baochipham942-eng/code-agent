import { describe, expect, it } from 'vitest';
import {
  comparabilityTag,
  computeDeltaPp,
  regressionsAgainstBaseline,
} from '@internal-evaluation/renderer/evalCenter/evalRunDelta';

describe('历史表相对对比基准变化', () => {
  it('T8：按 caseId 对齐，退步在前，独有题折叠计数', () => {
    const baseline = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `case-${index}`,
      { status: index < 8 ? 'passed' : 'failed', score: index < 8 ? 1 : 0 },
    ]));
    const currentValues = {
      ...baseline,
      'case-0': { status: 'failed', score: 0 },
      'case-1': { status: 'failed', score: 0 },
      'case-2': { status: 'failed', score: 0 },
      'case-8': { status: 'passed', score: 1 },
      'case-new-a': { status: 'passed', score: 1 },
      'case-new-b': { status: 'failed', score: 0 },
    };
    const current = Object.fromEntries(Object.entries(currentValues).reverse());
    const result = regressionsAgainstBaseline(baseline, current);
    expect(computeDeltaPp(0.6, 0.8)).toBeCloseTo(-20);
    expect(result.transitions.map((item) => item.kind)).toEqual([
      'regressed', 'regressed', 'regressed', 'fixed',
    ]);
    expect(result.transitions.map((item) => item.caseId)).toEqual([
      'case-0', 'case-1', 'case-2', 'case-8',
    ]);
    expect(result.uniqueCaseCount).toBe(2);
  });

  it('T9：计分规则优先阻断，题库更新只提示', () => {
    expect(comparabilityTag({
      baselineAggregationRuleVersion: 4,
      runAggregationRuleVersion: 3,
      baselineCaseBankSha: 'a',
      runCaseBankSha: 'b',
    })).toBe('old-rule');
    expect(comparabilityTag({
      baselineAggregationRuleVersion: 4,
      runAggregationRuleVersion: 4,
      baselineCaseBankSha: 'a',
      runCaseBankSha: 'b',
    })).toBe('case-bank-updated');
  });
});

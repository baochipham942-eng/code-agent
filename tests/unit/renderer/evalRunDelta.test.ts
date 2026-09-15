import { describe, expect, it } from 'vitest';
import {
  alwaysPassedCaseIds,
  comparabilityTag,
  computeDeltaPp,
  regressionsAgainstBaseline,
} from '@internal-evaluation/renderer/evalCenter/evalRunDelta';
import type { EvalBaselineCaseResult } from '../../../src/shared/contract/evaluationBaseline';

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

describe('零区分度标记：每题最近 5 次被跑全过', () => {
  const passed = { status: 'passed', score: 1 };
  const failed = { status: 'failed', score: 0 };
  // 5 轮 newest-first：always 每轮都过；once-failed 第 3 轮挂；absent 只被跑到 4 次
  const runs: Array<Record<string, EvalBaselineCaseResult>> = [
    { always: passed, 'once-failed': passed, absent: passed },
    { always: passed, 'once-failed': passed, absent: passed },
    { always: passed, 'once-failed': failed, absent: passed },
    { always: passed, 'once-failed': passed, absent: passed },
    { always: passed, 'once-failed': passed },
  ];

  it('被跑到的 5 次全 passed 才有标：挂过一次或只跑到 4 次的都无标', () => {
    const marked = alwaysPassedCaseIds(runs);
    expect([...marked]).toEqual(['always']);
  });

  it('被跑到的次数不足 5 次没资格说全过：返回空集', () => {
    expect(alwaysPassedCaseIds(runs.slice(0, 4)).size).toBe(0);
  });

  it('只看每题最近 5 次被跑：第 6 次的失败不影响', () => {
    expect(alwaysPassedCaseIds([...runs, { always: failed }]).has('always')).toBe(true);
  });

  // FB-158：held-in 组 5 轮题集不相交（两轮只有 1 道 bash-pwd），按「组内最近 5 轮」判会把所有题清零。
  it('题集不相交：中间夹一轮单题 smoke，其余题照样按自己最近 5 次判', () => {
    const wide = { wide: passed, other: passed };
    const marked = alwaysPassedCaseIds([
      wide,
      { lonely: passed },
      wide,
      wide,
      { lonely: passed },
      wide,
      wide,
    ]);
    expect([...marked].sort()).toEqual(['other', 'wide']);
  });
});

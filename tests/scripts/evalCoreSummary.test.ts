import { describe, expect, it } from 'vitest';
import {
  actualCostUsd,
  buildCoreSummary,
  detectModelDrift,
  regressedCases,
  type CoreReport,
} from '../../scripts/lib/eval-core-summary.mjs';

function report(overrides: {
  model?: string; provider?: string; endpoint?: string; judge?: string;
  results?: Array<{ testId: string; status: string; costUsd?: number }>;
  infraExcluded?: number;
}): CoreReport {
  const results = overrides.results ?? [];
  return {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    skipped: 0,
    infraExcluded: overrides.infraExcluded ?? 0,
    costExceeded: 0,
    results,
    environment: { model: overrides.model ?? 'deepseek-v4-flash', provider: overrides.provider ?? 'custom-tokenrhythm', endpoint: overrides.endpoint },
    stamp: { scorers: { judgeModel: overrides.judge ?? 'quick/deepseek-chat' } },
  };
}

describe('core 集周跑摘要', () => {
  it('被测模型与上轮不同时点名 A → B；相同则不报', () => {
    const prev = report({ model: 'deepseek-v4-flash' });
    expect(detectModelDrift(prev, report({ model: 'deepseek-v5' })))
      .toBe('被测模型已变：custom-tokenrhythm/deepseek-v4-flash → custom-tokenrhythm/deepseek-v5');
    expect(detectModelDrift(prev, report({}))).toBeNull();
    expect(detectModelDrift(undefined, report({}))).toBeNull();
  });

  it('裁判模型变了也点名（同源裁判换了会让分数不可比）', () => {
    expect(detectModelDrift(report({ judge: 'a' }), report({ judge: 'b' }))).toBe('裁判模型已变：a → b');
  });

  it('退步题 = 上轮 passed 本轮非 passed，按 id 排序并带状态', () => {
    const prev = report({ results: [{ testId: 'x', status: 'passed' }, { testId: 'y', status: 'passed' }, { testId: 'z', status: 'failed' }] });
    const curr = report({ results: [{ testId: 'y', status: 'failed' }, { testId: 'x', status: 'not_run' }, { testId: 'z', status: 'failed' }] });
    expect(regressedCases(prev, curr)).toEqual(['x（not_run）', 'y（failed）']);
  });

  it('实付只累加有真实归集的题，全无则 null', () => {
    expect(actualCostUsd(report({ results: [{ testId: 'a', status: 'passed', costUsd: 0.01 }, { testId: 'b', status: 'passed' }] }))).toBeCloseTo(0.01);
    expect(actualCostUsd(report({ results: [{ testId: 'a', status: 'passed' }] }))).toBeNull();
  });

  it('五行摘要：漂移在第一行，通过率口径不含环境故障，exit 2 有警示', () => {
    const prev = report({ model: 'm1', results: [{ testId: 'a', status: 'passed' }, { testId: 'b', status: 'passed' }, { testId: 'c', status: 'failed' }] });
    const curr = report({
      model: 'm2',
      results: [{ testId: 'a', status: 'passed', costUsd: 0.2 }, { testId: 'b', status: 'failed' }, { testId: 'c', status: 'infra_excluded' }],
      infraExcluded: 1,
    });
    const lines = buildCoreSummary({ current: curr, previous: prev, exitCode: 0, reportPath: '/r.json' }).split('\n');
    expect(lines[0]).toBe('⚠ 被测模型已变：custom-tokenrhythm/m1 → custom-tokenrhythm/m2');
    expect(lines[1]).toBe('通过率：50.0%（1/3，exit 0）');
    expect(lines[2]).toBe('Δ：-16.7 pp');
    expect(lines[3]).toBe('退步题：b（failed）');
    expect(lines[4]).toBe('实付：$0.2000');
    expect(lines[5]).toBe('被测 model：custom-tokenrhythm/m2（裁判 quick/deepseek-chat）');
    expect(lines[6]).toBe('报告：/r.json');

    const first = buildCoreSummary({ current: curr, previous: undefined, exitCode: 2 });
    expect(first.split('\n')[0]).toContain('exit 2');
    expect(first).toContain('Δ：无上一轮可比');
  });

  it('上一轮题数不同（5 题冒烟 vs 50 题周跑）时 Δ 标不可比，退步题仍按 id 点名', () => {
    const prev = report({ results: [{ testId: 'a', status: 'passed' }] });
    const curr = report({ results: [{ testId: 'a', status: 'failed' }, { testId: 'b', status: 'passed' }] });
    const text = buildCoreSummary({ current: curr, previous: prev, exitCode: 0 });
    expect(text).toContain('Δ：上一轮题数不同（1 vs 2），不可比');
    expect(text).toContain('退步题：a（failed）');
  });
});

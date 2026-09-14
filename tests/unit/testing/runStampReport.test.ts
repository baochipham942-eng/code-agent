import { describe, expect, it } from 'vitest';
import { UNKNOWN_EVAL_RUN_STAMP, type EvalRunStamp } from '../../../src/shared/contract/evaluation';
import { getRunStampReportRows } from '../../../src/host/testing/runStampReport';

function scorersRow(overrides: Partial<EvalRunStamp['scorers']>): string {
  const stamp: EvalRunStamp = { ...UNKNOWN_EVAL_RUN_STAMP, scorers: { ...UNKNOWN_EVAL_RUN_STAMP.scorers, ...overrides } };
  return getRunStampReportRows(stamp).find(([label]) => label === '打分器')![1];
}

describe('报告头 · 打分器行', () => {
  it('同源裁判时明示自我偏好未隔离', () => {
    expect(scorersRow({ aiReview: ['task_completed'], judgeSameSource: true })).toContain('⚠ 同源裁判');
  });

  it('异源或旧轮（未知）不打标', () => {
    expect(scorersRow({ aiReview: ['task_completed'], judgeSameSource: false })).not.toContain('同源裁判');
    expect(scorersRow({ aiReview: ['task_completed'] })).not.toContain('同源裁判');
  });
});

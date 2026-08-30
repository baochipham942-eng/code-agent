import { describe, expect, it } from 'vitest';
import { estimateDiscrimination } from '../../../src/host/testing/comparator/discrimination';
import type { EvalBaseline } from '../../../src/host/testing/types';

function baseline(scores: Record<string, number>): EvalBaseline {
  return {
    version: 1,
    plannedCaseIds: Object.keys(scores),
    updatedAt: 1,
    updatedBy: 'sha',
    globalMetrics: { passRate: 0.5, averageScore: 0.5, totalCases: Object.keys(scores).length },
    caseResults: Object.fromEntries(
      Object.entries(scores).map(([id, score]) => [id, { status: 'passed', score }]),
    ),
    thresholds: { minPassRate: 0.7, maxScoreDrop: 0.15, maxNewFailures: 2 },
  };
}

describe('compare 区分度预警', () => {
  it('历史 0.2–0.8 的题少于 30% 时预警，达到阈值时不预警', () => {
    expect(estimateDiscrimination(['a', 'b', 'c', 'd'], baseline({ a: 0.1, b: 0.9, c: 1, d: 0.5 })))
      .toMatchObject({ discriminatingCases: 1, ratio: 0.25, shouldWarn: true });
    expect(estimateDiscrimination(['a', 'b', 'c'], baseline({ a: 0.2, b: 0.9, c: 1 })))
      .toMatchObject({ discriminatingCases: 1, shouldWarn: false });
  });
});

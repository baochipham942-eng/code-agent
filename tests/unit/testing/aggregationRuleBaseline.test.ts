import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BaselineManager } from '../../../src/host/testing/ci/baselineManager';
import type { TestRunSummary } from '../../../src/host/testing/types';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function summary(rule: TestRunSummary['aggregationRule']): TestRunSummary {
  return {
    runId: 'rule-run',
    startTime: 0,
    endTime: 1,
    duration: 1,
    total: 1,
    plannedCaseIds: ['case-1'],
    completed: true,
    passed: 1,
    failed: 0,
    skipped: 0,
    partial: 0,
    infraExcluded: 0,
    costExceeded: 0,
    notRun: 0,
    invalidCases: 0,
    averageScore: 1,
    results: [{
      testId: 'case-1', description: 'case', status: 'passed', duration: 1,
      startTime: 0, endTime: 1, toolExecutions: [], responses: [], errors: [], turnCount: 1, score: 1,
    }],
    aggregationRule: rule,
    aggregationRuleVersion: 4,
    stamp: { ...UNKNOWN_EVAL_RUN_STAMP, k: rule === 'pass_caret_k' ? 2 : 1, aggregationRuleVersion: 4 },
    environment: { provider: 'mock', model: 'model', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
  };
}

describe('baseline aggregation rule guard', () => {
  it('rejects a legacy best-score baseline against a new repeated run in human language', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aggregation-baseline-'));
    roots.push(root);
    const manager = new BaselineManager(root);
    await manager.save({
      version: 1,
      denominatorVersion: 4,
      aggregationRule: 'best_score_pass_at_k',
      aggregationRuleVersion: 4,
      plannedCaseIds: ['case-1'],
      updatedAt: 1,
      updatedBy: 'legacy',
      mode: 'real',
      globalMetrics: { passRate: 1, averageScore: 1, totalCases: 1 },
      caseResults: { 'case-1': { status: 'passed', score: 1 } },
      thresholds: { minPassRate: 0.7, maxScoreDrop: 0.15, maxNewFailures: 2 },
    });

    await expect(manager.compare(summary('pass_caret_k'))).resolves.toEqual({
      comparable: false,
      reason: '两轮的计分规则不同，不能比',
    });
  });

  it('rejects comparison when current rules differ', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aggregation-baseline-'));
    roots.push(root);
    const manager = new BaselineManager(root);
    await manager.promote(summary('pass_rate_k1'), 'sha', 'real', ['case-1']);

    await expect(manager.compare(summary('pass_caret_k'))).resolves.toEqual({
      comparable: false,
      reason: '两轮的计分规则不同，不能比',
    });
  });

  it('rejects promotion when the round has no current aggregation rule', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aggregation-baseline-'));
    roots.push(root);
    const manager = new BaselineManager(root);

    await expect(manager.promote(summary(undefined), 'sha', 'real', ['case-1']))
      .rejects.toThrow(/旧口径|缺少版本/);
  });
});

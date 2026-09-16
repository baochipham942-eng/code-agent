import { describe, expect, it } from 'vitest';
import { generateMarkdownReport } from '../../../src/host/testing/reportGenerator';
import type { TestResult, TestRunSummary } from '../../../src/host/testing/types';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';

function result(testId: string, overrides: Partial<TestResult> = {}): TestResult {
  return {
    testId,
    description: testId,
    status: 'passed',
    duration: 1,
    startTime: 0,
    endTime: 1,
    toolExecutions: [],
    responses: [],
    errors: [],
    turnCount: 1,
    score: 1,
    ...overrides,
  };
}

function summary(results: TestResult[]): TestRunSummary {
  return {
    runId: 'unjudged-row-report', startTime: 0, endTime: 1, duration: 1,
    total: results.length, passed: results.length, failed: 0, partial: 0, skipped: 0,
    plannedCaseIds: results.map((item) => item.testId), completed: true, notRun: 0, invalidCases: 0,
    failureDistribution: { unknown: 0 },
    averageScore: 1, results,
    aggregationRule: 'pass_rate_k1', aggregationRuleVersion: 4,
    stamp: { ...UNKNOWN_EVAL_RUN_STAMP, aggregationRuleVersion: 4 },
    environment: { provider: 'openai', model: 'gpt-4o', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 2 },
  };
}

// N-EVAL-REPORT-UNJUDGED-ROW: 候选断言全部未判的超时题（expectationResults 为空数组）
// 也要出现在「期望断言详情」小节里，且打印未判类型。
describe('超时题全未判也要进报告', () => {
  it('expectationResults 为空数组时仍打印未判行', () => {
    const r = result('timeout-all-unjudged', {
      expectationResults: [],
      timeoutExpectations: { judged: [], unjudged: ['sim_stop_respected'] },
    });
    const markdown = generateMarkdownReport(summary([r]));
    expect(markdown).toContain('## 期望断言详情');
    expect(markdown).toContain('### timeout-all-unjudged');
    expect(markdown).toContain('未判：sim_stop_respected');
  });

  it('有 judged 断言时输出不变（回归）：仍出表格且不受未判分支影响', () => {
    const r = result('timeout-partial-judged', {
      expectationResults: [
        {
          expectation: { type: 'no_crash', description: 'no_crash', params: {} },
          passed: true,
          evidence: { actual: 'ok', expected: 'ok', details: 'ok' },
          duration: 1,
        },
      ],
      timeoutExpectations: { judged: ['no_crash'], unjudged: [] },
    });
    const markdown = generateMarkdownReport(summary([r]));
    expect(markdown).toContain('### timeout-partial-judged');
    expect(markdown).toContain('| 状态 | 描述 | 证据 |');
    expect(markdown).toContain('no_crash');
    expect(markdown).not.toContain('未判：');
  });

  it('无 timeoutExpectations 且 expectationResults 为空时不进小节（原有行为不变）', () => {
    const r = result('plain-no-expectations', { expectationResults: [] });
    const markdown = generateMarkdownReport(summary([r]));
    expect(markdown).not.toContain('### plain-no-expectations');
  });
});

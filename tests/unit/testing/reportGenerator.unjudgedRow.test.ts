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

// N-JEV-EVAL-JUDGE：弃权率看「无法确定」列；Jev 初筛决断/升级率与刊例估算单独汇总一行。
describe('AI 评审小节的 Jev 初筛汇总行', () => {
  const verdict = (prescreen: 'jev_decided' | 'escalated', prescreenCostUsd?: number) => ({
    verdict: 'yes' as const, reasoning: 'r', judgeModel: 'm', promptHash: 'h', prescreen, prescreenCostUsd,
  });

  it('有 prescreen 标记 ⇒ 打印决断/升级维次、升级率与按题去重的刊例估算', () => {
    const decided = result('case-decided', {
      aiReview: { task_completed: verdict('jev_decided', 0.00001) },
    });
    const escalated = result('case-escalated', {
      aiReview: {
        task_completed: verdict('escalated', 0.00002),
        confirmed_before_acting: verdict('escalated', 0.00002),
      },
    });
    const markdown = generateMarkdownReport(summary([decided, escalated]));
    expect(markdown).toContain('Jev 初筛：决断 1 维次 / 升级生成式 2 维次（升级率 66.7%）');
    // 同一题两维的同一份刊例只计一次：0.00001 + 0.00002 = 0.00003，不是 0.00005
    expect(markdown).toContain('初筛刊例估算 ≈ $0.000030');
  });

  it('无 prescreen 标记 ⇒ 不打印汇总行（默认关零变化）', () => {
    const plain = result('case-plain', {
      aiReview: { task_completed: { verdict: 'yes' as const, reasoning: 'r', judgeModel: 'm', promptHash: 'h' } },
    });
    const markdown = generateMarkdownReport(summary([plain]));
    expect(markdown).toContain('| 维度 | 是 | 否 | 无法确定 | 不可用 |');
    expect(markdown).not.toContain('Jev 初筛：');
  });
});

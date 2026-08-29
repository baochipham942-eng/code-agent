import { describe, expect, it } from 'vitest';
import { generateConsoleReport, generateJsonReport, generateMarkdownReport } from '../../../src/host/testing/reportGenerator';
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
    runId: 'cost-report', startTime: 0, endTime: 1, duration: 1,
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

describe('成本与用量报告', () => {
  it('环境信息完整展示本轮配置的人话行名', () => {
    const markdown = generateMarkdownReport(summary([]));
    expect(markdown).toContain('## 环境信息');
    for (const label of [
      '代码版本', '题库版本', '评测集', '打分器', '每题跑几次',
      '计分规则版本', '提示词版本', '本轮形态', '与生产默认的差异',
      '密钥来源', '价格表版本', '预估费用',
    ]) {
      expect(markdown).toContain(`| ${label} |`);
    }
  });

  it('k>1 概览只展示 k 次全过率，并输出组合聚合与修正后 sigma', () => {
    const run = summary([result('repeated', {
      status: 'failed',
      score: 0.3,
      trialAggregate: { n: 5, c: 3, passAtK: 0.9, passCaretK: 0.3, rule: 'pass_caret_k' },
      stdDev: 0.5477,
    })]);
    run.passed = 0;
    run.failed = 1;
    run.aggregationRule = 'pass_caret_k';
    run.stamp = { ...run.stamp, k: 2 };

    const markdown = generateMarkdownReport(run);
    const overview = markdown.slice(markdown.indexOf('## 概览'), markdown.indexOf('## 稳定性'));
    expect(overview).toContain('| k 次全过率（k=2） |');
    expect(overview).not.toContain('| 通过率 |');
    expect(markdown).toContain('| repeated | 5 | 3 | 0.9000 | 0.3000 | 0.5477 |');
  });

  it('逐 case 输出 provider token、USD，汇总严格等于逐 case 之和', () => {
    const run = summary([
      result('one', {
        usageStatus: 'available',
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsd: 0.00045,
      }),
      result('two', {
        usageStatus: 'available',
        usage: { promptTokens: 200, completionTokens: 30, totalTokens: 230, cacheReadTokens: 0, cacheCreationTokens: 0 },
        costUsd: 0.00055,
      }),
    ]);

    const markdown = generateMarkdownReport(run);
    expect(markdown).toContain('| one | 100 | 20 | 120 | $0.000450 |');
    expect(markdown).toContain('| two | 200 | 30 | 230 | $0.000550 |');
    expect(markdown).toContain('| **汇总（2/2 个 case 有 provider usage）** | **300** | **50** | **350** | **$0.001000** |');
    expect(generateConsoleReport(run)).toContain('Cost: $0.001000  |  Provider usage: 2/2 cases');
    expect(JSON.parse(generateJsonReport(run)).results[0]).toMatchObject({
      usageStatus: 'available',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      costUsd: 0.00045,
    });
  });

  it('缺 provider usage 时 fail-loud 标 usage_unavailable，不把 token 或 USD 写成 0', () => {
    const run = summary([result('missing-usage', { usageStatus: 'usage_unavailable' })]);
    const markdown = generateMarkdownReport(run);
    expect(markdown).toContain('| missing-usage | usage_unavailable | usage_unavailable | usage_unavailable | usage_unavailable |');
    expect(markdown).not.toContain('| missing-usage | 0 | 0 | 0 | $0.000000 |');
    expect(generateConsoleReport(run)).toContain('usage_unavailable 1');
  });
});

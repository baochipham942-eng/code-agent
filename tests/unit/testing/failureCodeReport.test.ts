import { describe, expect, it } from 'vitest';

import { generateMarkdownReport } from '../../../src/host/testing/reportGenerator';
import { generateComparisonMarkdown } from '../../../src/host/testing/comparator/comparisonReport';
import type { ComparisonResult, TestResult, TestRunSummary } from '../../../src/host/testing/types';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';

function failedResult(code: string, dispositions: string[]): TestResult {
  return {
    testId: `case-${code}`,
    description: '失败用例',
    status: 'failed',
    duration: 1,
    startTime: 0,
    endTime: 1,
    toolExecutions: [],
    responses: [],
    failureReason: '失败详情',
    errors: [],
    turnCount: 1,
    score: 0,
    failure: { code, dispositions, symptoms: code === 'unknown' ? [] : [code] },
  };
}

describe('失败原因报告', () => {
  it('单轮报告含 unknown 行、码的人话标签和处置轴计数', () => {
    const results = [failedResult('timeout', ['retryable']), failedResult('unknown', ['needs_human'])];
    const summary: TestRunSummary = {
      runId: 'failure-report', startTime: 0, endTime: 1, duration: 1,
      total: 2, passed: 0, failed: 2, partial: 0, skipped: 0,
      plannedCaseIds: results.map((result) => result.testId), completed: true, notRun: 0,
      invalidCases: 0, failureDistribution: { timeout: 1, unknown: 1 },
      failureCodebookSource: 'bundled',
      averageScore: 0, results,
      stamp: UNKNOWN_EVAL_RUN_STAMP,
      environment: { provider: 'mock', model: 'mock', workingDirectory: '/tmp' },
      performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 2 },
    };
    const markdown = generateMarkdownReport(summary);
    expect(markdown).toContain('失败原因码本：内置');
    expect(markdown).toContain('## 失败原因分布');
    // 分布表在 code 与数量之间多了「问题分类」一列（ADR-071 D1）
    expect(markdown).toContain('运行超时 <span style="color:#888"><code>timeout</code></span> | 稳定性问题 | 1');
    expect(markdown).toContain('未归类 <span style="color:#888"><code>unknown</code></span> | 未标注 | 1');
    expect(markdown).toContain('| 可以重试 | 1 |');
    expect(markdown).toContain('| 需要人工确认 | 1 |');
  });

  it('失败原因分布带问题分类与 code 级风险等级建议，合规码恒 P0（ADR-071 D3 / Q3）', () => {
    const results = [failedResult('compliance_risk', ['needs_human']), failedResult('timeout', [])];
    const summary: TestRunSummary = {
      runId: 'failure-risk', startTime: 0, endTime: 1, duration: 1,
      total: 2, passed: 0, failed: 2, partial: 0, skipped: 0,
      plannedCaseIds: results.map((result) => result.testId), completed: true, notRun: 0,
      invalidCases: 0, failureDistribution: { compliance_risk: 1, timeout: 1 },
      failureCodebookSource: 'project',
      averageScore: 0, results,
      stamp: UNKNOWN_EVAL_RUN_STAMP,
      environment: { provider: 'mock', model: 'mock', workingDirectory: '/tmp' },
      performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 2 },
    };
    const markdown = generateMarkdownReport(summary);
    expect(markdown).toContain('| 失败原因 | 问题分类 | 数量 | 风险等级（建议） | 依据 |');
    expect(markdown).toContain('与抽屉里人给的**题级**定级是两个口径');
    const complianceRow = markdown.split('\n').find((line) => line.includes('<code>compliance_risk</code>'));
    expect(complianceRow).toContain('| 合规风险 |');
    expect(complianceRow).toContain('| P0 |');
    expect(complianceRow).toContain('合规红线一票 P0，不进矩阵');
    const timeoutRow = markdown.split('\n').find((line) => line.includes('<code>timeout</code>'));
    expect(timeoutRow).toContain('| 稳定性问题 |');
    expect(timeoutRow).toMatch(/\| P[123] \|/);
    expect(timeoutRow).toContain('频率');
    expect(timeoutRow).toContain('影响');
  });

  it('--compare 报告按对照组和实验组分别统计失败码与处置标签', () => {
    const result: ComparisonResult = {
      runId: 'compare-failures',
      timestamp: 1,
      baseline: { name: 'baseline' },
      candidate: { name: 'candidate' },
      cases: [{
        testId: 'case-1', description: 'case-1',
        assignment: { A: 'candidate', B: 'baseline' },
        scoreA: { content: { correctness: 0, completeness: 0, accuracy: 0, total: 0 }, structure: { organization: 0, formatting: 0, usability: 0, total: 0 }, combined: 0 },
        scoreB: { content: { correctness: 0, completeness: 0, accuracy: 0, total: 0 }, structure: { organization: 0, formatting: 0, usability: 0, total: 0 }, combined: 0 },
        referenceWinner: 'tie', referenceKind: 'heuristic',
        assertionWinner: 'tie', passRateA: 0, passRateB: 0, assertionCount: 0,
        realWinner: 'tie', reasoning: 'same',
        statusA: 'failed', statusB: 'failed',
        failureA: { code: 'unknown', dispositions: ['needs_human'], symptoms: [] },
        failureB: { code: 'timeout', dispositions: ['retryable'], symptoms: ['timeout'] },
        durationA: 1, durationB: 1,
        skillActivationsA: {}, skillActivationsB: {},
        memoryInjectionsA: 0, memoryInjectionsB: 0,
        subagentSpawnsA: 0, subagentSpawnsB: 0,
      }],
      summary: {
        totalCases: 1, baselineWins: 0, candidateWins: 0, ties: 1,
        baselineAvgScore: 0, candidateAvgScore: 0, winner: 'tie', confidence: 0,
        verdict: '未检出差异',
        baselineSkillActivations: {}, candidateSkillActivations: {},
      },
      duration: 2,
    };
    const markdown = generateComparisonMarkdown(result);
    expect(markdown).toContain('| 失败原因 | 对照组 | 实验组 |');
    expect(markdown).toContain('<code>timeout</code></span> | 1 | 0 |');
    expect(markdown).toContain('<code>unknown</code></span> | 0 | 1 |');
    expect(markdown).toContain('| 可以重试 | 1 | 0 |');
    expect(markdown).toContain('| 需要人工确认 | 0 | 1 |');
  });
});

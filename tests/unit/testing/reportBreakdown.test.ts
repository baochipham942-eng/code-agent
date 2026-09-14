import { describe, expect, it } from 'vitest';
import { generateBreakdownSection, generateMarkdownReport } from '../../../src/host/testing/reportGenerator';
import { completePlannedResults } from '../../../src/host/testing/testRunCompletion';
import type { TestCase, TestResult, TestRunSummary } from '../../../src/host/testing/types';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';

function makeResult(overrides: Partial<TestResult>): TestResult {
  return {
    testId: 'case-x',
    description: 'desc',
    status: 'passed',
    duration: 100,
    startTime: 0,
    endTime: 100,
    toolExecutions: [],
    responses: [],
    errors: [],
    turnCount: 1,
    score: 1,
    scoreAuthority: 'deterministic_assertion',
    ...overrides,
  };
}

function makeSummary(results: TestResult[], extra: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    runId: 'run-1',
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    total: results.length,
    plannedCaseIds: results.map((result) => result.testId),
    completed: true,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: 0,
    partial: 0,
    infraExcluded: results.filter((r) => r.status === 'infra_excluded').length,
    notRun: 0,
    invalidCases: 0,
    averageScore: 1,
    results,
    stamp: UNKNOWN_EVAL_RUN_STAMP,
    environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 0, maxResponseTime: 0, totalToolCalls: 0, totalTurns: 0 },
    ...extra,
  };
}

const RESULTS: TestResult[] = [
  makeResult({ testId: 'tool-1', caseMeta: { tags: ['bash', 'smoke'], category: 'basic_tool', difficulty: 'easy', layer: 'L1' } }),
  makeResult({ testId: 'tool-2', caseMeta: { tags: ['bash'], category: 'basic_tool', difficulty: 'easy', layer: 'L1' } }),
  makeResult({ testId: 'task-1', caseMeta: { tags: ['report'], category: 'task_completion', difficulty: 'hard', layer: 'L2' } }),
  makeResult({ testId: 'task-2', status: 'failed', score: 0, caseMeta: { tags: ['report'], category: 'task_completion', difficulty: 'hard', layer: 'L2' } }),
  // 环境故障：分母外，但要在并列行里被数到
  makeResult({ testId: 'infra-1', status: 'infra_excluded', score: 0, caseMeta: { tags: ['report'], category: 'task_completion', difficulty: 'hard', layer: 'L2' } }),
];

describe('报告分层通过率', () => {
  it('两类 category 各 2 题一挂：表里两行数字精确，分母不含 infra_excluded', () => {
    const lines = generateBreakdownSection(makeSummary(RESULTS));
    expect(lines).toContain('| basic_tool | 2 | 2 | 100.0% |');
    expect(lines).toContain('| task_completion | 2 | 1 | 50.0% |');
    expect(lines).toContain('| easy | 2 | 2 | 100.0% |');
    expect(lines).toContain('| hard | 2 | 1 | 50.0% |');
    expect(lines).toContain('| L2 | 2 | 1 | 50.0% |');
    // 一题多 tag 进多行
    expect(lines).toContain('| bash | 2 | 2 | 100.0% |');
    expect(lines).toContain('| smoke | 1 | 1 | 100.0% |');
    expect(lines).toContain('| report | 2 | 1 | 50.0% |');
  });

  it('分母外行与通过率并列出现，含 infra_excluded 1', () => {
    const lines = generateBreakdownSection(makeSummary(RESULTS, { retiredSkipped: ['old-1', 'old-2'], notRun: 3, invalidCases: 1, costExceeded: 0 }));
    expect(lines).toContain('> 分母外：infra_excluded 1 · cost_exceeded 0 · retired 2 · not_run 3 · invalid 1');
  });

  it('没有 caseMeta 的题归「未标注」；self_check 题不进分母', () => {
    const lines = generateBreakdownSection(makeSummary([
      makeResult({ testId: 'legacy' }),
      makeResult({ testId: 'self', scoreAuthority: 'self_check', caseMeta: { tags: ['x'], category: 'edge_case' } }),
    ]));
    expect(lines).toContain('| 未标注 | 1 | 1 | 100.0% |');
    expect(lines.some((line) => line.startsWith('| edge_case |'))).toBe(false);
  });

  it('Markdown 报告含「分层通过率」段', () => {
    const report = generateMarkdownReport(makeSummary(RESULTS));
    expect(report).toContain('## 分层通过率');
    expect(report).toContain('| task_completion | 2 | 1 | 50.0% |');
  });
});

describe('结果带题目元数据快照', () => {
  it('completePlannedResults 把 tags(合并 inheritedTags 去重)/category/difficulty/layer 抄进已跑与未跑结果', () => {
    const cases: TestCase[] = [
      { id: 'ran', type: 'tool', description: 'd', prompt: 'p', expect: {}, tags: ['a', 'b'], inheritedTags: ['b', 'c'], category: 'basic_tool', difficulty: 'easy', layer: 'L1' },
      { id: 'planned-only', type: 'tool', description: 'd', prompt: 'p', expect: {} },
    ];
    const { results } = completePlannedResults(cases, [makeResult({ testId: 'ran' })], false);
    expect(results[0].caseMeta).toEqual({ tags: ['a', 'b', 'c'], category: 'basic_tool', difficulty: 'easy', layer: 'L1' });
    expect(results[1].status).toBe('not_run');
    expect(results[1].caseMeta).toEqual({ tags: [] });
  });
});

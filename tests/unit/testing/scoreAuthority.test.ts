// ============================================================================
// WP1-1 scoreAuthority 三桶 — 评分权威标注
// ============================================================================
// judge/自报分不再冒充硬 pass：每个 TestResult 标注分数来源
// （deterministic_assertion / llm_judge / self_check），报告分桶展示，
// L3 实验提案只准引用前两桶。先例：ForbiddenPatterns 先于 LLM grader、
// trendTracker real/mock 分离、baselineManager 拒 mock 晋升。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import { generateMarkdownReport } from '../../../src/host/testing/reportGenerator';
import { ExperimentAdapter } from '../../../src/host/evaluation/experimentAdapter';
import type { TestResult, TestRunSummary } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

function makeAgent(): AgentInterface {
  return {
    sendMessage: vi.fn(async () => ({
      responses: ['ok done'],
      toolExecutions: [],
      turnCount: 1,
      errors: [],
    })),
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'mock-agent', model: 'mock-model', provider: 'mock' }),
  };
}

async function runSuite(suiteYaml: string): Promise<TestRunSummary> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-score-authority-'));
  const casesDir = path.join(root, 'cases');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), suiteYaml);

  const runner = new TestRunner({
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: root,
    defaultTimeout: 1000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
  }, makeAgent());

  return runner.runAll();
}

describe('scoreAuthority 标注（testRunner）', () => {
  it('声明了确定性断言的 case 标为 deterministic_assertion', async () => {
    const summary = await runSuite([
      'name: authority',
      'cases:',
      '  - id: with-assertions',
      '    type: task',
      '    description: has real assertions',
      '    prompt: say ok',
      '    expect:',
      '      response_contains: [ok]',
      '',
    ].join('\n'));

    expect(summary.results[0].scoreAuthority).toBe('deterministic_assertion');
  });

  it('零断言自动通过的 case 标为 self_check', async () => {
    const summary = await runSuite([
      'name: authority',
      'cases:',
      '  - id: no-assertions',
      '    type: task',
      '    description: nothing verified',
      '    prompt: say ok',
      '    expect: {}',
      '',
    ].join('\n'));

    expect(summary.results[0].status).toBe('passed'); // 现状：空断言 min-1 自动 pass
    expect(summary.results[0].scoreAuthority).toBe('self_check');
  });

  it('P1 expectations 覆盖时仍为 deterministic_assertion', async () => {
    const summary = await runSuite([
      'name: authority',
      'cases:',
      '  - id: with-expectations',
      '    type: task',
      '    description: p1 expectations',
      '    prompt: say ok',
      '    expect: {}',
      '    expectations:',
      '      - type: response_contains',
      '        description: response mentions ok',
      '        params:',
      '          text: ok',
      '',
    ].join('\n'));

    expect(summary.results[0].scoreAuthority).toBe('deterministic_assertion');
  });
});

describe('scoreAuthority 分桶展示（reportGenerator）', () => {
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
      ...overrides,
    };
  }

  function makeSummary(results: TestResult[]): TestRunSummary {
    return {
      runId: 'run-1',
      startTime: 0,
      endTime: 1000,
      duration: 1000,
      total: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: 0,
      partial: 0,
      averageScore: 0.5,
      results,
      environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
      performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
    };
  }

  it('markdown 报告按权威桶分列计数，self_check 带不作能力证据说明', () => {
    const md = generateMarkdownReport(makeSummary([
      makeResult({ testId: 'det-1', scoreAuthority: 'deterministic_assertion' }),
      makeResult({ testId: 'det-2', status: 'failed', score: 0, scoreAuthority: 'deterministic_assertion' }),
      makeResult({ testId: 'self-1', scoreAuthority: 'self_check' }),
    ]));

    expect(md).toContain('评分权威');
    expect(md).toMatch(/deterministic_assertion.*2/);
    expect(md).toMatch(/self_check.*1/);
    expect(md).toContain('不作能力证据');
  });

  it('无标注的历史结果归入 unknown 行，不冒充 deterministic', () => {
    const md = generateMarkdownReport(makeSummary([
      makeResult({ testId: 'legacy-1' }),
    ]));

    expect(md).toMatch(/unknown.*1/);
  });
});

describe('scoreAuthority 透传（experimentAdapter）', () => {
  it('canonical case 保留 scoreAuthority', () => {
    const adapter = new ExperimentAdapter({
      insertExperiment: vi.fn(),
      insertExperimentCases: vi.fn(),
    });
    const summary: TestRunSummary = {
      runId: 'run-1',
      startTime: 0,
      endTime: 1,
      duration: 1,
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      partial: 0,
      averageScore: 1,
      results: [{
        testId: 'case-1',
        description: 'd',
        status: 'passed',
        duration: 1,
        startTime: 0,
        endTime: 1,
        toolExecutions: [],
        responses: [],
        errors: [],
        turnCount: 1,
        score: 1,
        scoreAuthority: 'deterministic_assertion',
      }],
      environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
      performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
    };

    const run = adapter.toCanonicalTestRun(summary);
    expect(run.cases[0].scoreAuthority).toBe('deterministic_assertion');
  });
});

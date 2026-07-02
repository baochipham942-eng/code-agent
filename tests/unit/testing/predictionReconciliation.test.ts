// ============================================================================
// WP1-4 predicted 对账 — prompt 改动的预测 vs 实际翻转对账
// ============================================================================
// 改 prompt 时登记 predictedFixes（预计修好的 case）/ riskTasks（预计有
// 风险的 case），跑完 eval 由 deltaReporter 自动对账：预测命中 / 落空 /
// 风险兑现 / 预测外翻转。复用 baselineManager 的 newFailures/newPasses。
// 预测外翻转是最值钱的信号——说明 prompt 改动有未预期的副作用。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import { generateDeltaConsole, generateDeltaMarkdown } from '../../../src/host/testing/ci/deltaReporter';
import { ExperimentAdapter } from '../../../src/host/evaluation/experimentAdapter';
import type { BaselineDelta, TestRunSummary } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

function makeSummary(overrides: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    runId: 'run-1',
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    partial: 0,
    averageScore: 0,
    results: [],
    environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
    ...overrides,
  };
}

function makeDelta(overrides: Partial<BaselineDelta> = {}): BaselineDelta {
  return {
    isFirstRun: false,
    passRateDelta: 0,
    scoreDelta: 0,
    newFailures: [],
    newPasses: [],
    isRegression: false,
    regressionDetails: [],
    ...overrides,
  };
}

describe('testRunner 透传 prediction', () => {
  it('config.prediction 进 summary（落盘/DB 可追溯）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-prediction-'));
    const casesDir = path.join(root, 'cases');
    await mkdir(casesDir, { recursive: true });
    await writeFile(path.join(casesDir, 'suite.yaml'), [
      'name: prediction',
      'cases:',
      '  - id: case-a',
      '    type: task',
      '    description: minimal',
      '    prompt: say ok',
      '    expect:',
      '      response_contains: [ok]',
      '',
    ].join('\n'));

    const agent: AgentInterface = {
      sendMessage: async () => ({ responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] }),
      reset: vi.fn(async () => undefined),
      getAgentInfo: () => ({ name: 'mock', model: 'm', provider: 'p' }),
    };

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
      prediction: { predictedFixes: ['case-a'], riskTasks: ['case-b'] },
    }, agent);

    const summary = await runner.runAll();
    expect(summary.prediction).toEqual({ predictedFixes: ['case-a'], riskTasks: ['case-b'] });
  });
});

describe('deltaReporter 对账节', () => {
  const summary = makeSummary({
    prediction: {
      predictedFixes: ['fix-hit', 'fix-missed'],
      riskTasks: ['risk-hit'],
    },
  });
  const delta = makeDelta({
    newPasses: [{ testId: 'fix-hit' }, { testId: 'surprise-pass' }],
    newFailures: [
      { testId: 'risk-hit', previousStatus: 'passed', currentStatus: 'failed' },
      { testId: 'surprise-fail', previousStatus: 'passed', currentStatus: 'failed', reason: 'oops' },
    ],
  });

  it('console：预测命中/落空/风险兑现/预测外翻转分列', () => {
    const out = generateDeltaConsole(summary, delta);

    expect(out).toContain('预测对账');
    expect(out).toMatch(/命中.*fix-hit/s);
    expect(out).toMatch(/落空.*fix-missed/s);
    expect(out).toMatch(/风险兑现.*risk-hit/s);
    expect(out).toMatch(/预测外.*surprise-pass/s);
    expect(out).toMatch(/预测外.*surprise-fail/s);
  });

  it('markdown：同样输出对账节', () => {
    const md = generateDeltaMarkdown(summary, delta);

    expect(md).toContain('预测对账');
    expect(md).toContain('fix-hit');
    expect(md).toContain('fix-missed');
    expect(md).toContain('surprise-fail');
  });

  it('无 prediction 时不输出对账节（向后兼容）', () => {
    const out = generateDeltaConsole(makeSummary(), delta);
    expect(out).not.toContain('预测对账');
  });

  it('风险未兑现的 riskTask 不出现在风险兑现列', () => {
    const out = generateDeltaConsole(makeSummary({
      prediction: { predictedFixes: [], riskTasks: ['risk-safe'] },
    }), makeDelta());
    expect(out).toContain('预测对账');
    expect(out).not.toMatch(/风险兑现.*risk-safe/s);
  });
});

describe('experimentAdapter 透传 prediction', () => {
  it('prediction 进 canonical run metadata', () => {
    const adapter = new ExperimentAdapter({
      insertExperiment: vi.fn(),
      insertExperimentCases: vi.fn(),
    });
    const run = adapter.toCanonicalTestRun(makeSummary({
      prediction: { predictedFixes: ['a'], riskTasks: [] },
    }));

    expect(run.metadata?.prediction).toEqual({ predictedFixes: ['a'], riskTasks: [] });
  });
});

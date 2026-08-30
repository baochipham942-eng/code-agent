import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaselineManager } from '../../../src/host/testing/ci/baselineManager';
import { generateMarkdownReport } from '../../../src/host/testing/reportGenerator';
import { TestRunner, isInfraExclusionError, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { TestResult, TestRunSummary } from '../../../src/host/testing/types';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';
import { initBudgetService } from '../../../src/host/services/core/budgetService';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

const roots: string[] = [];

afterEach(async () => {
  initBudgetService();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRunner(options: {
  parallel?: boolean;
  trialsPerCase?: number;
  provider?: string;
  independentCases?: boolean;
  realAgentRun?: boolean;
  sendMessage?: AgentInterface['sendMessage'];
} = {}): Promise<TestRunner> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-fake-closed-'));
  roots.push(root);
  const casesDir = path.join(root, 'cases');
  const workDir = path.join(root, 'work');
  await mkdir(casesDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), [
    'name: fake-closed',
    'cases:',
    '  - id: case-1',
    '    type: task',
    '    description: first',
    '    prompt: first',
    ...(options.realAgentRun ? ['    tags: [real-agent-run]'] : []),
    '    expect:',
    '      response_contains: [ok]',
    '  - id: case-2',
    '    type: task',
    '    description: aborts',
    '    prompt: abort',
    ...(options.realAgentRun ? ['    tags: [real-agent-run]'] : []),
    ...(options.independentCases ? [] : ['    depends_on: [case-1]']),
    '    expect:',
    '      response_contains: [ok]',
    '  - id: case-3',
    '    type: task',
    '    description: never scheduled',
    '    prompt: third',
    ...(options.realAgentRun ? ['    tags: [real-agent-run]'] : []),
    ...(options.independentCases ? [] : ['    depends_on: [case-2]']),
    '    expect:',
    '      response_contains: [ok]',
    '',
  ].join('\n'));

  const makeAgent = (): AgentInterface => ({
    sendMessage: options.sendMessage ?? (async (prompt) => prompt === 'abort'
      ? { responses: [], toolExecutions: [], turnCount: 0, errors: ['Insufficient account balance'] }
      : { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] }),
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'fixture-agent', model: 'fixture-model', provider: options.provider ?? 'mock' }),
  });

  return new TestRunner({
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: workDir,
    defaultTimeout: 1_000,
    stopOnFailure: false,
    verbose: false,
    parallel: options.parallel ?? false,
    maxParallel: options.parallel ? 2 : 1,
    enableEvalCritic: false,
    trialsPerCase: options.trialsPerCase,
  }, makeAgent(), options.parallel ? () => makeAgent() : undefined);
}

async function expectAbortedRun(summary: TestRunSummary): Promise<void> {
  expect(summary.plannedCaseIds).toEqual(['case-1', 'case-2', 'case-3']);
  expect(summary.total).toBe(3);
  expect(summary.results.map((result) => [result.testId, result.status])).toEqual([
    ['case-1', 'passed'],
    ['case-2', 'failed'],
    ['case-3', 'not_run'],
  ]);
  expect(summary.results[2].failureReason).toContain('轮次中断：Insufficient account balance');
  expect(summary.notRun).toBe(1);
  expect(summary.completed).toBe(false);

  const manager = new BaselineManager(summary.environment.workingDirectory);
  await expect(manager.compare(summary)).resolves.toEqual({
    comparable: false,
    reason: '本轮未跑满（1 题未跑），不与基准比较',
  });
  await expect(manager.promote(summary, 'abort-sha', 'real', summary.plannedCaseIds)).rejects.toThrow(/case-3.*轮次中断/);
}

describe('计划题集与 not_run', () => {
  it('串行 abort 后补齐未跑题并拒绝比较与设基准', async () => {
    await expectAbortedRun(await (await createRunner()).runAll());
  });

  it('并行调度 abort 后补齐未调度题', async () => {
    await expectAbortedRun(await (await createRunner({ parallel: true })).runAll());
  });

  it('多 trial abort 后仍保留计划题集', async () => {
    await expectAbortedRun(await (await createRunner({ trialsPerCase: 2 })).runAll());
  });
});

describe('题级无效判定', () => {
  it('真跑 usage 缺失时断言全过也不计 passed', async () => {
    const summary = await (await createRunner({
      provider: 'openai',
      independentCases: true,
      sendMessage: async () => ({ responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] }),
    })).runAll();

    expect(summary.completed).toBe(true);
    expect(summary.invalidCases).toBe(3);
    expect(summary.passed).toBe(0);
    expect(summary.results.every((result) => result.invalid?.reason === 'usage_unavailable')).toBe(true);
    expect(generateMarkdownReport(summary)).toContain('无效题（没调真模型）');
  });

  it('mock 环境下同样缺 usage 不判为无效', async () => {
    const summary = await (await createRunner({
      provider: 'mock',
      independentCases: true,
      sendMessage: async () => ({ responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] }),
    })).runAll();

    expect(summary.completed).toBe(true);
    expect(summary.invalidCases).toBe(0);
    expect(summary.passed).toBe(3);
  });

  it('多 trial 后发的 usage 缺失不能被同分真模型 trial 掩盖', async () => {
    initBudgetService({ enabled: false });
    let calls = 0;
    const run = await (await createRunner({
      provider: 'openai',
      independentCases: true,
      trialsPerCase: 2,
      sendMessage: async () => {
        calls++;
        if (calls % 2 === 1) {
          initBudgetService({ enabled: false }).recordUsage({
            inputTokens: 10,
            outputTokens: 5,
            model: 'fixture-model',
            provider: 'openai',
            timestamp: Date.now(),
          });
        }
        return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
      },
    })).runAll();

    expect(run.invalidCases).toBe(3);
    expect(run.passed).toBe(0);
    expect(run.results.every((item) => item.invalid?.reason === 'usage_unavailable')).toBe(true);
    expect(run.results.every((item) => item.trials?.[1]?.invalid?.reason === 'usage_unavailable')).toBe(true);
  });

  it.each([false, true])('多 trial 的无效题优先于遥测门失败（parallel=%s）', async (parallel) => {
    const runner = await createRunner({
      parallel,
      independentCases: true,
      realAgentRun: true,
      trialsPerCase: 2,
    });
    const calls = new Map<string, number>();
    vi.spyOn(runner, 'runSingleTest').mockImplementation(async (testCase) => {
      const trial = calls.get(testCase.id) ?? 0;
      calls.set(testCase.id, trial + 1);
      return trial === 0
        ? result(testCase.id, {
            status: 'failed',
            score: 0,
            failureStage: 'telemetry_replay_gate',
            telemetryGate: { name: 'real-agent-run', passed: false, failures: ['missing_real_agent_trace'] },
          })
        : result(testCase.id, {
            usageStatus: 'usage_unavailable',
            invalid: { reason: 'usage_unavailable' },
          });
    });

    const run = await runner.runAll();

    expect(run.invalidCases).toBe(3);
    expect(run.passed).toBe(0);
    expect(run.failed).toBe(0);
    expect(run.results.every((item) => item.invalid?.reason === 'usage_unavailable')).toBe(true);
  });

  it('invalid 判废优先：k=2 混合 invalid 通过与 infra 时进 invalidCases', async () => {
    const runner = await createRunner({ independentCases: true, trialsPerCase: 2 });
    const calls = new Map<string, number>();
    vi.spyOn(runner, 'runSingleTest').mockImplementation(async (testCase) => {
      const trial = calls.get(testCase.id) ?? 0;
      calls.set(testCase.id, trial + 1);
      return trial === 0
        ? result(testCase.id, {
            status: 'passed',
            invalid: { reason: 'usage_unavailable' },
            usageStatus: 'usage_unavailable',
          })
        : result(testCase.id, {
            status: 'infra_excluded',
            score: 0,
            failureReason: '503 Service Unavailable',
          });
    });

    const run = await runner.runAll();

    expect(run.invalidCases).toBe(3);
    expect(run.infraExcluded).toBe(0);
    expect(run.passed).toBe(0);
    expect(run.results.every((item) => item.invalid?.reason === 'usage_unavailable')).toBe(true);
  });
});

describe('超时归因', () => {
  it('harness 总时限超限算能力失败，provider 网络故障仍算环境故障', async () => {
    const timeoutSummary = await (await createRunner({
      sendMessage: async () => new Promise(() => undefined),
      independentCases: true,
    })).runAll();
    expect(timeoutSummary.results[0]).toMatchObject({
      status: 'failed',
      failureStage: 'timeout',
      killedByTimeout: true,
    });
    expect(isInfraExclusionError('timeout after 1000ms')).toBe(false);
    expect(isInfraExclusionError('fetch failed')).toBe(true);
    expect(isInfraExclusionError('connect ETIMEDOUT')).toBe(true);
  }, 5_000);

  it('provider 自报 request timeout after Nms 仍归环境故障', async () => {
    const run = await (await createRunner({
      independentCases: true,
      sendMessage: async () => { throw new Error('openai request timeout after 1000ms'); },
    })).runAll();

    expect(run.results.every((item) => item.status === 'infra_excluded')).toBe(true);
    expect(run.results.every((item) => item.killedByTimeout === false)).toBe(true);
  });
});

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
    runId: 'baseline-run',
    startTime: 0,
    endTime: 1,
    duration: 1,
    total: results.length,
    plannedCaseIds: results.map((item) => item.testId),
    completed: !results.some((item) => item.status === 'not_run'),
    passed: results.filter((item) => item.status === 'passed' && !item.invalid).length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    partial: results.filter((item) => item.status === 'partial').length,
    infraExcluded: results.filter((item) => item.status === 'infra_excluded').length,
    costExceeded: results.filter((item) => item.status === 'cost_exceeded').length,
    notRun: results.filter((item) => item.status === 'not_run').length,
    invalidCases: results.filter((item) => item.invalid).length,
    averageScore: 1,
    aggregationRule: 'pass_rate_k1',
    aggregationRuleVersion: 4,
    results,
    stamp: UNKNOWN_EVAL_RUN_STAMP,
    environment: { provider: 'openai', model: 'model', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
  };
}

describe('设基准硬门与旧规则', () => {
  it('缺 denominatorVersion 的旧基线拒绝比较', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-old-baseline-'));
    roots.push(root);
    const manager = new BaselineManager(root);
    await manager.save({
      version: 1,
      plannedCaseIds: ['case-1'],
      updatedAt: 1,
      updatedBy: 'old',
      globalMetrics: { passRate: 1, averageScore: 1, totalCases: 1 },
      caseResults: { 'case-1': { status: 'passed', score: 1 } },
      thresholds: { minPassRate: 0.7, maxScoreDrop: 0.15, maxNewFailures: 2 },
    });

    await expect(manager.compare(summary([result('case-1')]))).resolves.toEqual({
      comparable: false,
      reason: '基线口径较老，请重新设为对比基准',
    });
  });

  // 2026-08-29 监工补：Grok 变异席抓到「版本存在但≠4 只 warn 不拒绝」36/36 全绿——上一条只钉了缺字段。
  it('版本号不等的旧基线（denominatorVersion: 3）同样拒绝比较，不许只 warn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-v3-baseline-'));
    roots.push(root);
    const manager = new BaselineManager(root);
    await manager.save({
      version: 1,
      denominatorVersion: 3,
      plannedCaseIds: ['case-1'],
      updatedAt: 1,
      updatedBy: 'old',
      globalMetrics: { passRate: 1, averageScore: 1, totalCases: 1 },
      caseResults: { 'case-1': { status: 'passed', score: 1 } },
      thresholds: { minPassRate: 0.7, maxScoreDrop: 0.15, maxNewFailures: 2 },
    });

    await expect(manager.compare(summary([result('case-1')]))).resolves.toEqual({
      comparable: false,
      reason: '基线口径较老，请重新设为对比基准',
    });
  });

  it('完整跑完的子集也不能与全集基准比较', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-subset-compare-'));
    roots.push(root);
    const manager = new BaselineManager(root);
    await manager.save({
      version: 1,
      denominatorVersion: 4,
      aggregationRule: 'pass_rate_k1',
      aggregationRuleVersion: 4,
      plannedCaseIds: ['case-1', 'case-2'],
      updatedAt: 1,
      updatedBy: 'baseline',
      globalMetrics: { passRate: 1, averageScore: 1, totalCases: 2 },
      caseResults: {
        'case-1': { status: 'passed', score: 1 },
        'case-2': { status: 'passed', score: 1 },
      },
      thresholds: { minPassRate: 0.7, maxScoreDrop: 0.15, maxNewFailures: 2 },
    });

    await expect(manager.compare(summary([result('case-1')]))).resolves.toEqual({
      comparable: false,
      reason: '本轮计划题集与基准不一致，不与基准比较',
    });
  });

  it('计划题集少于加载到的全集时拒绝设基准', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-partial-baseline-'));
    roots.push(root);
    const manager = new BaselineManager(root);
    await expect(
      manager.promote(summary([result('case-1')]), 'sha', 'real', ['case-1', 'case-2']),
    ).rejects.toThrow(/缺少: case-2/);
  });

  it.each([undefined, []] as const)('调用方不提供全集时拒绝设基准（%j）', async (expectedCaseIds) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-missing-full-set-'));
    roots.push(root);
    const manager = new BaselineManager(root);
    const current = summary([result('case-1')]);
    await expect(
      manager.promote(
        current,
        'sha',
        'real',
        expectedCaseIds === undefined ? undefined as never : [...expectedCaseIds],
      ),
    ).rejects.toThrow(/缺少本轮加载到的评测集全集/);
  });

  it('notRun 汇总计数单独存在时仍拒绝设基准', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-not-run-baseline-'));
    roots.push(root);
    const manager = new BaselineManager(root);
    const current = summary([result('case-1')]);
    current.notRun = 1;
    await expect(manager.promote(current, 'sha', 'real', current.plannedCaseIds)).rejects.toThrow(/未跑.*汇总记录 1 题/);
  });

  it.each([
    ['skipped', result('case-skip', { status: 'skipped', score: 0, failureReason: '依赖未满足' })],
    ['infra', result('case-infra', { status: 'infra_excluded', score: 0, failureReason: 'fetch failed' })],
    ['cost', result('case-cost', { status: 'cost_exceeded', score: 0, failureReason: '成本超限' })],
    ['invalid', result('case-invalid', { invalid: { reason: 'usage_unavailable' } })],
  ])('%s 题存在时拒绝设基准并列出题号', async (_label, caseResult) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eval-reject-baseline-'));
    roots.push(root);
    const manager = new BaselineManager(root);
    const current = summary([caseResult]);
    await expect(manager.promote(current, 'sha', 'real', current.plannedCaseIds)).rejects.toThrow(caseResult.testId);
  });
});

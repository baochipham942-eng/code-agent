// ============================================================================
// WP1-2 infra_excluded 失败分桶 — 基础设施故障不进能力分母
// ============================================================================
// 429/5xx/网络错是环境噪声；harness 总时限超限是能力失败。
// 逼出「45 子集 + concurrency 1」的流程性回避。分流进 infra 桶后：
// 能力通过率分母排除、baseline 对账跳过、报告单列 —— 解锁更大 eval 子集。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';
import fs from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import { generateMarkdownReport } from '../../../src/host/testing/reportGenerator';
import { BaselineManager } from '../../../src/host/testing/ci/baselineManager';
import { ExperimentAdapter } from '../../../src/host/evaluation/experimentAdapter';
import type { TestEvent, TestResult, TestRunSummary } from '../../../src/host/testing/types';
import { EvalRunEventStream, type EvalRunStartConfig } from '../../../scripts/lib/eval-run-event-stream';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

const SUITE_YAML = [
  'name: infra',
  'cases:',
  '  - id: infra-case',
  '    type: task',
  '    description: case under test',
  '    prompt: say ok',
  '    expect:',
  '      response_contains: [ok]',
  '',
].join('\n');

async function runWith(
  agent: AgentInterface,
  opts: { timeout?: number; trialsPerCase?: number; events?: TestEvent[] } = {},
): Promise<TestRunSummary> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-infra-excluded-'));
  const casesDir = path.join(root, 'cases');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), SUITE_YAML);

  const runner = new TestRunner({
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: root,
    defaultTimeout: opts.timeout ?? 1000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
    trialsPerCase: opts.trialsPerCase,
  }, agent);

  if (opts.events) {
    runner.addEventListener((event) => opts.events?.push(event));
  }

  return runner.runAll();
}

function agentWith(sendMessage: AgentInterface['sendMessage']): AgentInterface {
  return {
    sendMessage,
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'mock-agent', model: 'mock-model', provider: 'mock' }),
  };
}

describe('testRunner infra 分流', () => {
  it('sendMessage 抛 429 → infra_excluded 不计 failed', async () => {
    const summary = await runWith(agentWith(async () => {
      throw new Error('Request failed with status code 429: rate limit exceeded');
    }));

    expect(summary.results[0].status).toBe('infra_excluded');
    expect(summary.failed).toBe(0);
    expect(summary.infraExcluded).toBe(1);
  });

  // 2026-08-28 爸拍板 v2.1 §18.13③：harness 总时限从「环境故障（infra_excluded）」反转为「能力失败」。
  // 后续若再反转，必须在验收证据中留名，不能静默改回旧断言。
  it('2026-08-28 爸拍板 v2.1 §18.13③ 反转：case 总时限超限 → failed + timeout（不再归 infra）', async () => {
    const summary = await runWith(agentWith(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
    }), { timeout: 50 });

    expect(summary.results[0]).toMatchObject({
      status: 'failed',
      failureStage: 'timeout',
      killedByTimeout: true,
    });
    expect(summary.infraExcluded).toBe(0);
  });

  it('errors 数组带网络错且零产出 → infra_excluded（adapter 不 throw 路径）', async () => {
    const summary = await runWith(agentWith(async () => ({
      responses: [],
      toolExecutions: [],
      turnCount: 0,
      errors: ['inference error: socket hang up'],
    })));

    expect(summary.results[0].status).toBe('infra_excluded');
  });

  it('真实断言失败仍是 failed，不混进 infra 桶', async () => {
    const summary = await runWith(agentWith(async () => ({
      responses: ['wrong answer'],
      toolExecutions: [],
      turnCount: 1,
      errors: [],
    })));

    expect(summary.results[0].status).toBe('failed');
    expect(summary.infraExcluded ?? 0).toBe(0);
  });

  it('k=3 混入一次环境故障时题级排除且轮次正常结束', async () => {
    let call = 0;
    const events: TestEvent[] = [];
    const summary = await runWith(agentWith(async () => {
      call += 1;
      if (call === 1) throw new Error('503 Service Unavailable');
      return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
    }), { trialsPerCase: 3, events });

    expect(summary).toMatchObject({
      completed: true,
      passed: 0,
      failed: 0,
      infraExcluded: 1,
    });
    expect(summary.results[0]).toMatchObject({
      status: 'infra_excluded',
      trialAggregate: {
        n: 2,
        c: 2,
        passAtK: 0,
        passCaretK: 0,
        rule: 'pass_caret_k',
      },
    });
    expect(events.at(-1)).toMatchObject({ type: 'suite_end' });
    expect(generateMarkdownReport(summary)).toContain('不计入主指标（环境故障）');

    let ndjson = '';
    const writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: string) => {
      if (fd === process.stdout.fd) ndjson += data;
      return Buffer.byteLength(data);
    }) as typeof fs.writeSync);
    const stream = new EvalRunEventStream('infra-repeat-run');
    const eventConfig: EvalRunStartConfig = {
      ...UNKNOWN_EVAL_RUN_STAMP,
      k: 3,
      aggregationRuleVersion: 4,
      mode: 'mock',
      model: 'mock-model',
      provider: 'mock',
      scope: 'smoke',
      maxCases: 1,
      concurrency: 1,
      gitCommit: 'test-sha',
      testCaseDir: '/tmp/test-cases',
    };
    try {
      events.forEach((event) => stream.forward(event, eventConfig));
      stream.recordSummary(summary);
      stream.finish(0);
    } finally {
      writeSpy.mockRestore();
    }
    const protocolEvents = ndjson.trim().split('\n').map((line) => JSON.parse(line));
    expect(protocolEvents.at(-1)).toMatchObject({
      type: 'run_end',
      exitCode: 0,
      summary: {
        completed: true,
        infraExcluded: 1,
        aggregationRule: 'pass_caret_k',
      },
    });
  });

  it('avgScore 分母排除 infra 桶', async () => {
    let call = 0;
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-infra-avg-'));
    const casesDir = path.join(root, 'cases');
    await mkdir(casesDir, { recursive: true });
    await writeFile(path.join(casesDir, 'suite.yaml'), [
      'name: infra',
      'cases:',
      '  - id: ok-case',
      '    type: task',
      '    description: passes',
      '    prompt: say ok',
      '    expect:',
      '      response_contains: [ok]',
      '  - id: rate-limited-case',
      '    type: task',
      '    description: hits 429',
      '    prompt: say ok',
      '    expect:',
      '      response_contains: [ok]',
      '',
    ].join('\n'));

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
    }, agentWith(async () => {
      call += 1;
      if (call > 1) throw new Error('503 Service Unavailable');
      return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
    }));

    const summary = await runner.runAll();
    // 只有 ok-case 进分母：avgScore = 1.0（若 infra 进了分母会稀释成 0.5）
    expect(summary.averageScore).toBe(1);
  });
});

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
    plannedCaseIds: results.map((result) => result.testId),
    completed: true,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    partial: results.filter((r) => r.status === 'partial').length,
    infraExcluded: results.filter((r) => r.status === 'infra_excluded').length,
    notRun: 0,
    invalidCases: 0,
    averageScore: 1,
    aggregationRule: 'pass_rate_k1',
    aggregationRuleVersion: 4,
    results,
    stamp: UNKNOWN_EVAL_RUN_STAMP,
    environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
  };
}

describe('baselineManager 与 infra 桶', () => {
  it('compare：passRate 分母排除 infra；曾 pass 现 infra 不算 newFailure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-infra-baseline-'));
    const manager = new BaselineManager(root);

    await manager.promote(makeSummary([
      makeResult({ testId: 'a', status: 'passed' }),
      makeResult({ testId: 'b', status: 'passed' }),
    ]), 'commit-1', 'real', ['a', 'b']);

    const delta = await manager.compare(makeSummary([
      makeResult({ testId: 'a', status: 'passed' }),
      makeResult({ testId: 'b', status: 'infra_excluded', score: 0, failureReason: '429' }),
    ]));
    expect(delta.comparable).toBe(true);
    if (!delta.comparable) throw new Error(delta.reason);

    expect(delta.newFailures).toHaveLength(0);
    // 能力分母 = 1（b 被排除），passRate 1/1 = 100%，无回归
    expect(delta.passRateDelta).toBe(0);
    expect(delta.isRegression).toBe(false);
  });

  it('promote：存在环境故障时拒绝设为基准', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-infra-promote-'));
    const manager = new BaselineManager(root);

    await expect(manager.promote(makeSummary([
      makeResult({ testId: 'a', status: 'passed' }),
      makeResult({ testId: 'b', status: 'infra_excluded', score: 0 }),
    ]), 'commit-1', 'real', ['a', 'b'])).rejects.toThrow(/环境故障.*b/);
  });
});

describe('报告与 canonical 映射', () => {
  it('markdown 报告单列 infra 桶且通过率分母排除', () => {
    const md = generateMarkdownReport(makeSummary([
      makeResult({ testId: 'a', status: 'passed' }),
      makeResult({ testId: 'b', status: 'infra_excluded', score: 0, failureReason: '429 rate limit' }),
    ]));

    expect(md).toContain('不计入通过率（环境故障）');
    expect(md).toContain('429 rate limit');
    // 通过率 1/1 = 100%（b 不进分母）
    expect(md).toContain('| 通过率 | 100.0% |');
  });

  it('experimentAdapter：infra_excluded 映射 skipped + metadata 标记', () => {
    const adapter = new ExperimentAdapter({
      insertExperiment: vi.fn(),
      insertExperimentCases: vi.fn(),
    });
    const run = adapter.toCanonicalTestRun(makeSummary([
      makeResult({ testId: 'b', status: 'infra_excluded', score: 0, failureReason: '429' }),
    ]));

    expect(run.cases[0].status).toBe('skipped');
    expect(run.cases[0].metadata?.infraExcluded).toBe(true);
  });
});

describe('fetch failed 分流（2026-07-03 断网实测缺口）', () => {
  // Node fetch/undici 网络不可达的通用报错不在 retryStrategy 瞬态词表里，
  // 断网窗口 115 个 case 被记成 failed 混进能力分母——必须进 infra 桶
  it('sendMessage 抛 fetch failed → infra_excluded', async () => {
    const summary = await runWith(agentWith(async () => {
      throw new Error('fetch failed');
    }));
    expect(summary.results[0].status).toBe('infra_excluded');
    expect(summary.failed).toBe(0);
  });

  it('errors 数组带 fetch failed 且零产出 → infra_excluded', async () => {
    const summary = await runWith(agentWith(async () => ({
      responses: [],
      toolExecutions: [],
      turnCount: 0,
      errors: ['LongCat inference error: fetch failed'],
    })));
    expect(summary.results[0].status).toBe('infra_excluded');
  });
});

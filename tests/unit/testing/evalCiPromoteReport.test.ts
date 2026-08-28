import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { TestRunSummary } from '../../../src/host/testing/types';

const saveReportMock = vi.hoisted(() => vi.fn());
const compareMock = vi.hoisted(() => vi.fn());
const promoteMock = vi.hoisted(() => vi.fn());
const runAllMock = vi.hoisted(() => vi.fn());
const eventListenerState = vi.hoisted(() => ({ listener: undefined as ((event: unknown) => void) | undefined }));
const trendAppendMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/testing/index', () => ({
  TestRunner: vi.fn(function TestRunner() {
    return {
      addEventListener: vi.fn((listener: (event: unknown) => void) => {
        eventListenerState.listener = listener;
      }),
      runAll: runAllMock,
    };
  }),
  createDefaultConfig: vi.fn((workingDirectory: string, overrides: Record<string, unknown> = {}) => ({
    testCaseDir: path.join(workingDirectory, '.code-agent', 'test-cases'),
    resultsDir: path.join(workingDirectory, '.code-agent', 'test-results'),
    workingDirectory,
    ...overrides,
  })),
  MockAgentAdapter: vi.fn(function MockAgentAdapter() {
    return { setMockResponse: vi.fn() };
  }),
  StandaloneAgentAdapter: vi.fn(function StandaloneAgentAdapter() {}),
  loadAllTestSuites: vi.fn(async () => [{
    name: 'suite',
    cases: [
      { id: 'case-a', type: 'task', prompt: 'prompt', expect: {} },
      { id: 'case-b', type: 'task', prompt: 'prompt', expect: {} },
    ],
  }]),
  filterTestCases: vi.fn((suites: Array<{ cases: unknown[] }>) => suites.flatMap((suite) => suite.cases)),
  generateConsoleReport: vi.fn(() => 'console report'),
  saveReport: saveReportMock,
}));

vi.mock('../../../src/host/testing/ci/baselineManager', () => ({
  BaselineManager: vi.fn(function BaselineManager() {
    return {
      compare: compareMock,
      promote: promoteMock,
    };
  }),
}));

vi.mock('../../../src/host/testing/ci/trendTracker', () => ({
  TrendTracker: vi.fn(function TrendTracker() {
    return {
      append: trendAppendMock,
      getRecent: vi.fn(),
      generateAsciiChart: vi.fn(),
    };
  }),
}));

vi.mock('../../../src/host/testing/ci/changeDetector', () => ({
  ChangeDetector: vi.fn(function ChangeDetector() {
    return {
      detectTriggeringChanges: vi.fn(async () => ({
        scope: 'full',
        shouldRunEval: true,
        triggerReason: 'test',
        changedFiles: [],
      })),
    };
  }),
}));

vi.mock('../../../src/host/testing/ci/deltaReporter', () => ({
  generateDeltaConsole: vi.fn(() => 'delta report'),
}));

vi.mock('../../../src/host/prompts/providerVariants', () => ({
  isProviderVariantDisabled: vi.fn(() => false),
}));

// 按名字枚举的 mock 会在 constants 每次新增导出时炸（本次实测：新增
// EXPLORE_AGENT_DESCRIPTION 直接让 spawnAgent.schema 的模板求值失败）。
// spread 真实模块后只覆盖要改的两个，新增导出不再牵连本测试。
vi.mock('../../../src/shared/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/shared/constants')>()),
  DEFAULT_PROVIDER: 'mock-provider',
  DEFAULT_MODEL: 'mock-model',
}));

function makeSummary(overrides: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    runId: 'run-promote',
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    total: 1,
    plannedCaseIds: ['case-a'],
    completed: true,
    passed: 1,
    failed: 0,
    skipped: 0,
    partial: 0,
    infraExcluded: 0,
    notRun: 0,
    invalidCases: 0,
    averageScore: 1,
    results: [],
    environment: { model: 'mock-model', provider: 'mock-provider', workingDirectory: '/tmp/work' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
    ...overrides,
  };
}

let root: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-eval-ci-promote-report-'));
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(
    path.join(root, '.claude', 'eval-splits.json'),
    JSON.stringify({
      version: 1,
      seed: 'test-seed',
      createdAt: '2026-07-26T00:00:00.000Z',
      heldIn: ['case-a', 'case-b'],
      heldOut: [],
      control: ['case-a'],
      safety: [],
    }),
  );
  process.env.AUTO_TEST_API_KEY = 'test-key';
  saveReportMock.mockReset();
  saveReportMock.mockResolvedValue([path.join(root, '.code-agent', 'test-results', 'report.md')]);
  compareMock.mockReset();
  promoteMock.mockReset();
  trendAppendMock.mockReset();
  runAllMock.mockReset();
  eventListenerState.listener = undefined;
  runAllMock.mockImplementation(async () => {
    const summary = makeSummary();
    eventListenerState.listener?.({
      type: 'suite_start',
      suite: 'all',
      totalCases: 1,
      plannedCaseIds: ['case-a'],
    });
    eventListenerState.listener?.({ type: 'suite_end', summary });
    return summary;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  await rm(root, { recursive: true, force: true });
});

describe('eval-ci promote reports', () => {
  it('saves Markdown and JSON in promote mode without baseline delta or baseline compare', async () => {
    const { main } = await import('../../../scripts/eval-ci');
    await main(['node', 'eval-ci.ts', '--promote', '--real', '--ids', 'case-a', '--max-cases', '1', '--force'], root);

    expect(saveReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-promote' }),
      path.join(root, '.code-agent', 'test-results'),
      ['markdown', 'json'],
    );
    expect(saveReportMock.mock.calls[0][3]).toBeUndefined();
    expect(compareMock).not.toHaveBeenCalled();
    expect(promoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-promote' }),
      expect.any(String),
      'real',
      ['case-a', 'case-b'],
    );
  });

  it('emits a final run_end with exit 2 when an eval summary is aborted', async () => {
    const summary = makeSummary({ aborted: true, abortReason: 'simulated abort' });
    runAllMock.mockImplementationOnce(async () => {
      eventListenerState.listener?.({
        type: 'suite_start',
        suite: 'all',
        totalCases: 1,
        plannedCaseIds: ['case-a'],
      });
      eventListenerState.listener?.({ type: 'suite_end', summary });
      return summary;
    });

    const stdout: string[] = [];
    const writeSyncSpy = vi.spyOn(fs, 'writeSync').mockImplementation(((_fd: number, chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    }) as typeof fs.writeSync);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__process_exit_${code}__`);
    }) as never);

    const { main } = await import('../../../scripts/eval-ci');
    await expect(
      main(['node', 'eval-ci.ts', '--promote', '--real', '--max-cases', '1', '--json-events'], root),
    ).rejects.toThrow('__process_exit_2__');

    const runEndWrite = writeSyncSpy.mock.calls.findIndex(([, chunk]) => String(chunk).includes('"type":"run_end"'));
    expect(runEndWrite).toBeGreaterThanOrEqual(0);
    expect(writeSyncSpy.mock.invocationCallOrder[runEndWrite]).toBeLessThan(exitSpy.mock.invocationCallOrder[0]);
    const events = stdout.join('').trim().split('\n').map((line) => JSON.parse(line)) as Array<{
      type: string;
      exitCode?: number;
      aborted?: boolean;
      abortReason?: string;
    }>;
    expect(events[0]?.type).toBe('run_start');
    expect(events.at(-1)).toMatchObject({
      type: 'run_end',
      exitCode: 2,
      aborted: true,
      abortReason: 'simulated abort',
    });
    expect(saveReportMock).toHaveBeenCalledTimes(1);
  });

  it('未跑满轮 exit 2 且不追加 trend', async () => {
    const incomplete = makeSummary();
    incomplete.completed = false;
    incomplete.notRun = 1;
    incomplete.results = [{
      testId: 'case-a',
      description: 'case-a',
      status: 'not_run',
      duration: 0,
      startTime: 0,
      endTime: 0,
      toolExecutions: [],
      responses: [],
      errors: [],
      turnCount: 0,
      score: 0,
      failureReason: '轮次中断：测试',
    }];
    runAllMock.mockResolvedValue(incomplete);
    compareMock.mockResolvedValue({
      comparable: false,
      reason: '本轮未跑满（1 题未跑），不与基准比较',
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);

    const { main } = await import('../../../scripts/eval-ci');
    await expect(main(['node', 'eval-ci.ts', '--scope', 'full'], root)).rejects.toThrow('exit:2');
    expect(exit).toHaveBeenCalledWith(2);
    expect(trendAppendMock).not.toHaveBeenCalled();
  });
});

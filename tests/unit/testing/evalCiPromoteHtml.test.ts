import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { TestRunSummary } from '../../../src/host/testing/types';

const saveReportMock = vi.hoisted(() => vi.fn());
const compareMock = vi.hoisted(() => vi.fn());
const promoteMock = vi.hoisted(() => vi.fn());
const runAllMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/testing/index', () => ({
  TestRunner: vi.fn(function TestRunner() {
    return {
      addEventListener: vi.fn(),
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
    cases: [{ id: 'case-a', type: 'task', prompt: 'prompt', expect: {} }],
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
      append: vi.fn(),
      getRecent: vi.fn(),
      generateAsciiChart: vi.fn(),
    };
  }),
}));

vi.mock('../../../src/host/testing/ci/deltaReporter', () => ({
  generateDeltaConsole: vi.fn(() => 'delta report'),
}));

vi.mock('../../../src/host/prompts/providerVariants', () => ({
  isProviderVariantDisabled: vi.fn(() => false),
}));

vi.mock('../../../src/shared/constants', () => ({
  DEFAULT_PROVIDER: 'mock-provider',
  DEFAULT_MODEL: 'mock-model',
}));

function makeSummary(): TestRunSummary {
  return {
    runId: 'run-promote',
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    partial: 0,
    infraExcluded: 0,
    averageScore: 1,
    results: [],
    environment: { model: 'mock-model', provider: 'mock-provider', workingDirectory: '/tmp/work' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
  };
}

let root: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-eval-ci-promote-html-'));
  process.env.AUTO_TEST_API_KEY = 'test-key';
  saveReportMock.mockReset();
  saveReportMock.mockResolvedValue([path.join(root, '.code-agent', 'test-results', 'report.html')]);
  compareMock.mockReset();
  promoteMock.mockReset();
  runAllMock.mockReset();
  runAllMock.mockResolvedValue(makeSummary());
});

afterEach(async () => {
  process.env = { ...savedEnv };
  await rm(root, { recursive: true, force: true });
});

describe('eval-ci promote HTML report', () => {
  it('saves HTML in promote mode without baseline delta or baseline compare', async () => {
    const { main } = await import('../../../scripts/eval-ci');
    await main(['node', 'eval-ci.ts', '--promote', '--real', '--max-cases', '1'], root);

    expect(saveReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-promote' }),
      path.join(root, '.code-agent', 'test-results'),
      ['markdown', 'json', 'html'],
    );
    expect(saveReportMock.mock.calls[0][3]).toBeUndefined();
    expect(compareMock).not.toHaveBeenCalled();
    expect(promoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-promote' }),
      expect.any(String),
      'real',
    );
  });
});

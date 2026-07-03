import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { TestRunSummary } from '../../../src/host/testing/types';

const saveReportMock = vi.hoisted(() => vi.fn());
const runAllMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/testing/reportGenerator', () => ({
  generateMarkdownReport: vi.fn(() => 'markdown'),
  generateConsoleReport: vi.fn(() => 'console report'),
  saveReport: saveReportMock,
}));

vi.mock('../../../src/host/testing/testRunner', () => ({
  createDefaultConfig: vi.fn((workingDirectory: string, overrides: Record<string, unknown>) => ({
    testCaseDir: overrides.testCaseDir,
    resultsDir: overrides.resultsDir,
    workingDirectory,
    stopOnFailure: false,
    verbose: false,
    ...overrides,
  })),
  TestRunner: vi.fn(function TestRunner() {
    return {
    addEventListener: vi.fn(),
    runAll: runAllMock,
    };
  }),
}));

vi.mock('../../../src/host/testing/agentAdapter', () => ({
  MockAgentAdapter: vi.fn(function MockAgentAdapter() {}),
  StandaloneAgentAdapter: vi.fn(function StandaloneAgentAdapter() {}),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/host/config', () => ({
  getTestDirs: (workingDirectory: string) => ({
    testCases: {
      new: path.join(workingDirectory, '.code-agent', 'test-cases'),
      legacy: path.join(workingDirectory, '.claude', 'test-cases'),
    },
    results: {
      new: path.join(workingDirectory, '.code-agent', 'test-results'),
      legacy: path.join(workingDirectory, '.claude', 'test-results'),
    },
  }),
  resolvePathWithFallback: vi.fn(async (primary: string) => ({ resolved: primary, source: 'primary' })),
}));

vi.mock('../../../src/shared/constants', () => ({
  DEFAULT_PROVIDER: 'mock-provider',
  DEFAULT_MODEL: 'mock-model',
}));

function makeSummary(): TestRunSummary {
  return {
    runId: 'run-1',
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
  root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-auto-test-html-'));
  await mkdir(path.join(root, '.code-agent', 'test-cases'), { recursive: true });
  process.env.AUTO_TEST = 'true';
  saveReportMock.mockReset();
  saveReportMock.mockResolvedValue([
    path.join(root, '.code-agent', 'test-results', 'report.md'),
    path.join(root, '.code-agent', 'test-results', 'report.json'),
    path.join(root, '.code-agent', 'test-results', 'report.html'),
  ]);
  runAllMock.mockReset();
  runAllMock.mockResolvedValue(makeSummary());
});

afterEach(async () => {
  process.env = { ...savedEnv };
  await rm(root, { recursive: true, force: true });
});

describe('autoTestHook HTML report default', () => {
  it('writes markdown, json, and html reports without baseline delta', async () => {
    const { runAutoTests } = await import('../../../src/host/testing/autoTestHook');
    const summary = await runAutoTests({ workingDirectory: root } as never);

    expect(summary).not.toBeNull();
    expect(saveReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1' }),
      path.join(root, '.code-agent', 'test-results'),
      ['markdown', 'json', 'html'],
    );
    expect(saveReportMock.mock.calls[0][3]).toBeUndefined();
  });
});

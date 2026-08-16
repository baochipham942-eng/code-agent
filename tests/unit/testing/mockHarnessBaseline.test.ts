import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { BaselineManager } from '../../../src/host/testing/ci/baselineManager';
import { generateDeltaConsole } from '../../../src/host/testing/ci/deltaReporter';
import { generateHtmlReport, generateMarkdownReport } from '../../../src/host/testing/reportGenerator';
import type { TestResult, TestRunSummary } from '../../../src/host/testing/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function result(testId: string, status: TestResult['status'], mockExcluded?: { reason: string }): TestResult {
  return {
    testId,
    description: testId,
    status,
    duration: 1,
    startTime: 0,
    endTime: 1,
    toolExecutions: [],
    responses: [],
    errors: [],
    turnCount: 1,
    score: status === 'passed' ? 1 : 0,
    ...(mockExcluded ? { mockExcluded } : {}),
  };
}

function summary(results: TestResult[]): TestRunSummary {
  return {
    runId: 'mock-run',
    startTime: 0,
    endTime: 1,
    duration: 1,
    total: results.length,
    passed: results.filter((item) => item.status === 'passed').length,
    failed: results.filter((item) => item.status === 'failed').length,
    partial: results.filter((item) => item.status === 'partial').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    mockExcluded: results.filter((item) => item.mockExcluded).length,
    infraExcluded: 0,
    costExceeded: 0,
    averageScore: 1,
    results,
    environment: { provider: 'mock', model: 'mock-model', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
  };
}

describe('mock harness baseline', () => {
  it('三种报告都按能力分母报 100%，并列出 mock 排除名单与理由', () => {
    const current = summary([
      result('fixture-a', 'passed'),
      result('real-only-b', 'skipped', { reason: 'requires real model' }),
    ]);
    const firstRunDelta = {
      isFirstRun: true,
      passRateDelta: 0,
      scoreDelta: 0,
      newFailures: [],
      newPasses: [],
      isRegression: false,
      regressionDetails: [],
    };

    expect(generateDeltaConsole(current, firstRunDelta)).toContain('Pass Rate:  100.0%');
    const markdown = generateMarkdownReport(current);
    expect(markdown).toContain('Mock 不适用用例');
    expect(markdown).toContain('real-only-b');
    expect(markdown).toContain('requires real model');
    const html = generateHtmlReport(current);
    expect(html).toContain('data-testid="mock-excluded-count">1');
    expect(html).toContain('real-only-b');
    expect(html).toContain('requires real model');
  });

  it('与 real baseline 分文件，使用 denominatorVersion=3 并保留排除名单', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mock-harness-baseline-'));
    roots.push(root);
    const manager = new BaselineManager(root, { kind: 'mock-harness' });
    await manager.promoteMockHarness(summary([
      result('fixture-a', 'passed'),
      result('real-only-b', 'skipped', { reason: 'requires real model' }),
    ]), 'sha-mock');

    const baseline = await manager.load();
    expect(baseline).toMatchObject({
      mode: 'mock',
      denominatorVersion: 3,
      globalMetrics: { passRate: 1, averageScore: 1, totalCases: 1 },
      excludedCases: { 'real-only-b': 'requires real model' },
    });
    expect(baseline?.caseResults).toEqual({
      'fixture-a': expect.objectContaining({ status: 'passed', score: 1 }),
    });
    await expect(readFile(path.join(root, '.claude/eval-mock-baseline.json'), 'utf8')).resolves.toContain('real-only-b');
    await expect(readFile(path.join(root, '.code-agent/eval-baseline.json'), 'utf8')).rejects.toThrow();
  });

  it('拒绝给非全绿 fixture 生成 mock baseline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mock-harness-baseline-'));
    roots.push(root);
    const manager = new BaselineManager(root, { kind: 'mock-harness' });

    await expect(manager.promoteMockHarness(summary([
      result('fixture-a', 'partial'),
    ]), 'sha-mock')).rejects.toThrow(/全绿|passed|partial/i);
  });
});

// ============================================================================
// baseline 分母口径 A 方案：compare/promote 与报告口径统一为
// 能力分母 = total − skipped − infra_excluded（WP1-2 完整形态）。
// 此前 compare/promote 只减 infra 不减 skipped，带 skipped 的 run 出现
// 「报告 100% / baseline delta 50%」分裂（批 5 codex 审计 deferred HIGH）。
// 迁移：baseline 新增 denominatorVersion=2；读到旧版基线只告警不硬拦。
// ============================================================================

import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import { BaselineManager } from '../../../src/host/testing/ci/baselineManager';
import type { TestResult, TestRunSummary } from '../../../src/host/testing/types';

function makeResult(overrides: Partial<TestResult>): TestResult {
  return {
    testId: 'case-a',
    description: 'desc',
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

function makeSummary(results: TestResult[]): TestRunSummary {
  return {
    runId: 'run-1',
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    partial: results.filter((r) => r.status === 'partial').length,
    infraExcluded: results.filter((r) => r.status === 'infra_excluded').length,
    averageScore: 1,
    results,
    environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('baseline 分母排除 skipped（A 方案）', () => {
  it('compare：1 passed + 1 skipped 的 run 通过率为 100%（codex 审计原始 repro）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.promote(makeSummary([makeResult({ testId: 'a' })]), 'sha1');

    const delta = await manager.compare(makeSummary([
      makeResult({ testId: 'a' }),
      makeResult({ testId: 'b', status: 'skipped', score: 0 }),
    ]));

    // 旧口径分母=2 → passRate 0.5 → delta -0.5 且触发 minPassRate 回归；新口径应为 0
    expect(delta.passRateDelta).toBeCloseTo(0);
    expect(delta.isRegression).toBe(false);
  });

  it('promote：capabilityTotal 排除 skipped，skipped 不落 caseResults，写 denominatorVersion=2', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.promote(makeSummary([
      makeResult({ testId: 'a' }),
      makeResult({ testId: 'b', status: 'skipped', score: 0 }),
      makeResult({ testId: 'c', status: 'infra_excluded', score: 0 }),
    ]), 'sha2');

    const baseline = await manager.load();
    expect(baseline?.globalMetrics.passRate).toBe(1);
    expect(baseline?.globalMetrics.totalCases).toBe(1);
    expect(baseline?.caseResults.b).toBeUndefined();
    expect(baseline?.caseResults.c).toBeUndefined();
    expect(baseline?.denominatorVersion).toBe(2);
  });

  it('读旧版基线（无 denominatorVersion）→ 告警不硬拦，比较照常', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.save({
      version: 1,
      updatedAt: 1,
      updatedBy: 'legacy',
      globalMetrics: { passRate: 1, averageScore: 1, totalCases: 1 },
      caseResults: { a: { status: 'passed', score: 1 } },
      thresholds: { minPassRate: 0.7, maxScoreDrop: 0.15, maxNewFailures: 2 },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const delta = await manager.compare(makeSummary([makeResult({ testId: 'a' })]));
    expect(delta.isFirstRun).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('denominatorVersion'));
  });

  it('新版基线不告警', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.promote(makeSummary([makeResult({ testId: 'a' })]), 'sha3');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.compare(makeSummary([makeResult({ testId: 'a' })]));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Gemini 审计 R1 修复', () => {
  it('HIGH: compare 尊重 summary.infraExcluded 显式值（与 promote/报告同一 coalesce）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.promote(makeSummary([makeResult({ testId: 'a' })]), 'sha');

    // total=2 含 1 个 infra，但 results 数组只带 1 条 passed（调用方允许不一致，见 ci.mode.test）
    const summary = makeSummary([makeResult({ testId: 'a' })]);
    summary.total = 2;
    summary.infraExcluded = 1;
    const delta = await manager.compare(summary);
    // 分母 = 2 - 0(skipped) - 1(infra显式) = 1 → passRate 1.0 → delta 0
    expect(delta.passRateDelta).toBeCloseTo(0);
  });

  it('MED: v1 基线里的 skipped 条目视同不存在（不因基线版本产生 newPasses 分叉）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.save({
      version: 1,
      updatedAt: 1,
      updatedBy: 'legacy',
      globalMetrics: { passRate: 1, averageScore: 1, totalCases: 2 },
      caseResults: {
        a: { status: 'passed', score: 1 },
        b: { status: 'skipped', score: 0 },
      },
      thresholds: { minPassRate: 0.7, maxScoreDrop: 0.15, maxNewFailures: 2 },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const delta = await manager.compare(makeSummary([
      makeResult({ testId: 'a' }),
      makeResult({ testId: 'b' }),
    ]));
    // v2 基线不含 skipped 条目、b 不触发 newPass；v1 必须同行为
    expect(delta.newPasses).toEqual([]);
  });
});

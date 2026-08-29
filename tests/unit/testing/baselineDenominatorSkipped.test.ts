// ============================================================================
// baseline 分母口径 A 方案：compare/promote 与报告口径统一为
// 能力分母 = total − skipped − infra_excluded − cost_exceeded。
// 此前 compare/promote 只减 infra 不减 skipped，带 skipped 的 run 出现
// 「报告 100% / baseline delta 50%」分裂（批 5 codex 审计 deferred HIGH）。
// 迁移：denominatorVersion=4 将计划题集与 not_run 纳入规则；旧版拒绝比较。
// ============================================================================

import { describe, expect, it, vi, afterEach } from 'vitest';
import { UNKNOWN_EVAL_RUN_STAMP } from '../../../src/shared/contract/evaluation';
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
    plannedCaseIds: results.map((result) => result.testId),
    completed: true,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    partial: results.filter((r) => r.status === 'partial').length,
    infraExcluded: results.filter((r) => r.status === 'infra_excluded').length,
    costExceeded: results.filter((r) => r.status === 'cost_exceeded').length,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('baseline 分母排除 skipped（A 方案）', () => {
  it('compare：1 passed + 1 skipped 的 run 通过率为 100%（codex 审计原始 repro）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.save({
      version: 1,
      denominatorVersion: 4,
      aggregationRule: 'pass_rate_k1',
      aggregationRuleVersion: 4,
      plannedCaseIds: ['a', 'b'],
      updatedAt: 1,
      updatedBy: 'sha1',
      mode: 'real',
      globalMetrics: { passRate: 1, averageScore: 1, totalCases: 1 },
      caseResults: { a: { status: 'passed', score: 1 } },
      thresholds: { minPassRate: 0.7, maxScoreDrop: 0.15, maxNewFailures: 2 },
    });

    const delta = await manager.compare(makeSummary([
      makeResult({ testId: 'a' }),
      makeResult({ testId: 'b', status: 'skipped', score: 0 }),
    ]));
    expect(delta.comparable).toBe(true);
    if (!delta.comparable) throw new Error(delta.reason);

    // 旧口径分母=2 → passRate 0.5 → delta -0.5 且触发 minPassRate 回归；新口径应为 0
    expect(delta.passRateDelta).toBeCloseTo(0);
    expect(delta.isRegression).toBe(false);
  });

  it('promote：存在 skipped / infra / cost 时拒绝设为基准', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await expect(manager.promote(makeSummary([
      makeResult({ testId: 'a' }),
      makeResult({ testId: 'b', status: 'skipped', score: 0 }),
      makeResult({ testId: 'c', status: 'infra_excluded', score: 0 }),
      makeResult({ testId: 'd', status: 'cost_exceeded', score: 0 }),
    ]), 'sha2', 'real', ['a', 'b', 'c', 'd'])).rejects.toThrow(/b.*c.*d/);
  });

  it('读旧版基线（无 denominatorVersion）→ 拒绝比较', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.save({
      version: 1,
      plannedCaseIds: ['a'],
      updatedAt: 1,
      updatedBy: 'legacy',
      globalMetrics: { passRate: 1, averageScore: 1, totalCases: 1 },
      caseResults: { a: { status: 'passed', score: 1 } },
      thresholds: { minPassRate: 0.7, maxScoreDrop: 0.15, maxNewFailures: 2 },
    });
    const delta = await manager.compare(makeSummary([makeResult({ testId: 'a' })]));
    expect(delta).toEqual({ comparable: false, reason: '基线口径较老，请重新设为对比基准' });
  });

  it('新版基线不告警', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.promote(makeSummary([makeResult({ testId: 'a' })]), 'sha3', 'real', ['a']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.compare(makeSummary([makeResult({ testId: 'a' })]));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Gemini 审计 R1 修复', () => {
  it('HIGH: compare 尊重 summary.infraExcluded 显式值（与 promote/报告同一 coalesce）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.promote(makeSummary([makeResult({ testId: 'a' })]), 'sha', 'real', ['a']);

    // total=2 含 1 个 infra，但 results 数组只带 1 条 passed（调用方允许不一致，见 ci.mode.test）
    const summary = makeSummary([makeResult({ testId: 'a' })]);
    summary.total = 2;
    summary.infraExcluded = 1;
    const delta = await manager.compare(summary);
    expect(delta.comparable).toBe(true);
    if (!delta.comparable) throw new Error(delta.reason);
    // 分母 = 2 - 0(skipped) - 1(infra显式) = 1 → passRate 1.0 → delta 0
    expect(delta.passRateDelta).toBeCloseTo(0);
  });

  it('MED: v1 基线里的 skipped 条目视同不存在（不因基线版本产生 newPasses 分叉）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-denom-'));
    const manager = new BaselineManager(root);
    await manager.save({
      version: 1,
      denominatorVersion: 4,
      aggregationRule: 'pass_rate_k1',
      aggregationRuleVersion: 4,
      plannedCaseIds: ['a', 'b'],
      updatedAt: 1,
      updatedBy: 'legacy',
      globalMetrics: { passRate: 1, averageScore: 1, totalCases: 2 },
      caseResults: {
        a: { status: 'passed', score: 1 },
        b: { status: 'skipped', score: 0 },
      },
      thresholds: { minPassRate: 0.7, maxScoreDrop: 0.15, maxNewFailures: 2 },
    });
    const delta = await manager.compare(makeSummary([
      makeResult({ testId: 'a' }),
      makeResult({ testId: 'b' }),
    ]));
    expect(delta.comparable).toBe(true);
    if (!delta.comparable) throw new Error(delta.reason);
    // v2 基线不含 skipped 条目、b 不触发 newPass；v1 必须同行为
    expect(delta.newPasses).toEqual([]);
  });
});

describe('per-case 模型归因（费曼审计 P1-4 顺带项）', () => {
  it('promote 给每个 caseResult 打上 provider/model', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-model-'));
    const manager = new BaselineManager(root);
    await manager.promote(makeSummary([makeResult({ testId: 'a' })]), 'sha-model', 'real', ['a']);

    const baseline = await manager.load();
    expect(baseline?.caseResults['a']?.model).toBeTruthy();
    expect(baseline?.caseResults['a']?.model).toContain('/');
  });
});

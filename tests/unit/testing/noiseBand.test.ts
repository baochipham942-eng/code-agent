// ============================================================================
// WP1b 样本工程 — 噪声带实测替换固定 maxScoreDrop=0.15
// ============================================================================
// 0.15 是拍脑袋值：比真实 run-to-run 噪声宽 → 漏报回归；比噪声窄 → 假警报。
// sweep（同子集同配置重复 K 跑）测出 avgScore 的实测 σ，
// maxScoreDrop = clamp(2σ, floor, cap) 落盘；baselineManager compare 优先用它。
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  computeNoiseBand,
  saveNoiseBand,
  loadNoiseBand,
  NOISE_BAND_LIMITS,
  type NoiseBandFile,
} from '../../../src/host/testing/ci/noiseBand';
import { BaselineManager } from '../../../src/host/testing/ci/baselineManager';
import type { TestResult, TestRunSummary } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ insertExperiment: vi.fn(), insertExperimentCases: vi.fn() }),
}));

describe('computeNoiseBand', () => {
  it('样本标准差（n-1）与 2σ 带宽', () => {
    const band = computeNoiseBand([0.8, 0.84, 0.82, 0.86, 0.78]);
    // 均值 0.82，样本方差 sum(d^2)/4 = 0.001，σ≈0.0316，2σ≈0.0632
    expect(band.stdDev).toBeCloseTo(0.0316, 3);
    expect(band.maxScoreDrop).toBeCloseTo(0.0632, 3);
  });

  it('2σ 低于 floor 时钳到 floor（防零方差把门焊死）', () => {
    const band = computeNoiseBand([0.8, 0.8, 0.8, 0.8, 0.8]);
    expect(band.stdDev).toBe(0);
    expect(band.maxScoreDrop).toBe(NOISE_BAND_LIMITS.floor);
  });

  it('2σ 高于 cap 时钳到 cap（噪声大到离谱应修 eval 而非放宽门）', () => {
    const band = computeNoiseBand([0.1, 0.9, 0.1, 0.9, 0.1]);
    expect(band.maxScoreDrop).toBe(NOISE_BAND_LIMITS.cap);
  });

  it('少于 3 个样本拒绝计算（σ 不可信）', () => {
    expect(() => computeNoiseBand([0.8, 0.9])).toThrow(/样本|runs/);
  });

  it('per-case 翻转率：K 跑里状态不稳定的 case 被点名', () => {
    const band = computeNoiseBand([0.8, 0.8, 0.8], {
      'flaky-case': ['passed', 'failed', 'passed'],
      'stable-case': ['passed', 'passed', 'passed'],
    });
    expect(band.caseFlipRates?.['flaky-case']).toBeCloseTo(2 / 3, 5);
    expect(band.caseFlipRates?.['stable-case']).toBeUndefined();
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

function makeSummary(results: TestResult[], averageScore: number): TestRunSummary {
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
    infraExcluded: 0,
    averageScore,
    results,
    environment: { model: 'm', provider: 'p', workingDirectory: '/tmp' },
    performance: { avgResponseTime: 1, maxResponseTime: 1, totalToolCalls: 0, totalTurns: 1 },
  };
}

describe('noiseBand 文件落盘', () => {
  it('save → load 往返；缺文件 → null', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'noise-band-'));
    expect(await loadNoiseBand(dir)).toBeNull();
    const file: NoiseBandFile = {
      version: 1,
      runs: 5,
      avgScores: [0.8, 0.82, 0.84, 0.8, 0.82],
      stdDev: 0.016,
      maxScoreDrop: 0.05,
      computedAt: '2026-07-03T00:00:00.000Z',
      model: 'LongCat-2.0',
    };
    await saveNoiseBand(dir, file);
    expect(await loadNoiseBand(dir)).toEqual(file);
  });
});

describe('baselineManager 用实测噪声带替换固定 maxScoreDrop', () => {
  it('有噪声带文件 → compare 用实测 maxScoreDrop（0.10 掉分在 0.15 固定门下漏报，实测 0.04 门下报回归）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noise-baseline-'));
    const manager = new BaselineManager(root);
    await manager.promote(makeSummary([makeResult({ testId: 'a' })], 1.0), 'commit-1', 'real');

    await saveNoiseBand(path.join(root, '.code-agent'), {
      version: 1,
      runs: 5,
      avgScores: [1, 1, 0.99, 1, 1],
      stdDev: 0.02,
      maxScoreDrop: 0.04,
      computedAt: '2026-07-03T00:00:00.000Z',
    });

    const delta = await manager.compare(makeSummary([makeResult({ testId: 'a', score: 0.9 })], 0.9));
    expect(delta.isRegression).toBe(true);
    expect(delta.regressionDetails.join(' ')).toContain('4.0%');
  });

  it('无噪声带文件 → 维持默认 0.15 行为（0.10 掉分不算回归）', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'noise-baseline-default-'));
    const manager = new BaselineManager(root);
    await manager.promote(makeSummary([makeResult({ testId: 'a' })], 1.0), 'commit-1', 'real');

    const delta = await manager.compare(makeSummary([makeResult({ testId: 'a', score: 0.9 })], 0.9));
    expect(delta.isRegression).toBe(false);
  });
});

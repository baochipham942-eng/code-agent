// ============================================================================
// 运行来源可信度（eval run provenance）
// ============================================================================
// 背景：trend / baseline 此前不区分 mock 与 real 运行。实测数据里 117 个 case
// 的 mock 跑只用 ~1.4 秒，real 跑要 20+ 分钟，但两者同流写入 trend，且当前
// 线上 baseline 正是从一次 mock 跑晋升而来 —— 33% 通过率是 mock adapter 的
// 产物，不是 agent 真实能力。本测试锁定三条护栏：
//   1. mock 运行禁止晋升为 baseline（promote 抛错）
//   2. real 晋升时 baseline 记录 mode=real 来源
//   3. trend 图表与按 mode 过滤能区分 mock / real
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { BaselineManager } from '../../../src/main/testing/ci/baselineManager';
import { TrendTracker } from '../../../src/main/testing/ci/trendTracker';
import { CONFIG_DIR_NEW } from '../../../src/main/config/configPaths';
import type { TestRunSummary, TrendDataPoint } from '../../../src/main/testing/types';

function makeSummary(overrides: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    runId: 'run-1',
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    total: 10,
    passed: 9,
    failed: 1,
    skipped: 0,
    partial: 0,
    averageScore: 0.9,
    results: [
      { testId: 'a', status: 'passed', score: 1, endTime: 1000 } as any,
      { testId: 'b', status: 'failed', score: 0 } as any,
    ],
    ...overrides,
  } as TestRunSummary;
}

function makeTrendPoint(overrides: Partial<TrendDataPoint> = {}): TrendDataPoint {
  return {
    timestamp: 1_700_000_000_000,
    commitSha: 'abcdef1234567890',
    scope: 'smoke',
    passRate: 0.9,
    averageScore: 0.9,
    totalCases: 10,
    duration: 1000,
    newFailures: 0,
    newPasses: 0,
    ...overrides,
  };
}

let workingDir: string;

beforeEach(async () => {
  workingDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-ci-mode-'));
});

afterEach(async () => {
  await rm(workingDir, { recursive: true, force: true });
});

describe('BaselineManager 来源护栏', () => {
  it('拒绝把 mock 运行晋升为 baseline', async () => {
    const manager = new BaselineManager(workingDir);
    await expect(manager.promote(makeSummary(), 'sha-mock', 'mock')).rejects.toThrow(/mock/i);
    // 未写盘
    expect(await manager.load()).toBeNull();
  });

  it('real 晋升时 baseline 记录 mode=real', async () => {
    const manager = new BaselineManager(workingDir);
    await manager.promote(makeSummary(), 'sha-real', 'real');
    const baseline = await manager.load();
    expect(baseline).not.toBeNull();
    expect(baseline!.mode).toBe('real');
    expect(baseline!.globalMetrics.passRate).toBeCloseTo(0.9);
  });

  it('mode 默认按 real 处理（向后兼容旧调用）', async () => {
    const manager = new BaselineManager(workingDir);
    await manager.promote(makeSummary(), 'sha-default');
    const baseline = await manager.load();
    expect(baseline!.mode).toBe('real');
  });
});

describe('TrendTracker 区分 mock / real', () => {
  it('getRecent 可按 mode 过滤，旧的无 mode 条目不计入 real', async () => {
    const tracker = new TrendTracker(workingDir);
    await tracker.append(makeTrendPoint({ timestamp: 1, mode: 'mock', duration: 1400 }));
    await tracker.append(makeTrendPoint({ timestamp: 2, mode: 'real', duration: 1_600_000 }));
    await tracker.append(makeTrendPoint({ timestamp: 3 })); // 旧条目，无 mode

    const realOnly = await tracker.getRecent(10, 'real');
    expect(realOnly.map((p) => p.timestamp)).toEqual([2]);

    const all = await tracker.getRecent(10);
    expect(all).toHaveLength(3);
  });

  it('图表标注每条 run 的 mode', async () => {
    const tracker = new TrendTracker(workingDir);
    const chart = tracker.generateAsciiChart([
      makeTrendPoint({ mode: 'mock' }),
      makeTrendPoint({ mode: 'real' }),
      makeTrendPoint({}), // 无 mode → 未知
    ]);
    expect(chart).toMatch(/mock/);
    expect(chart).toMatch(/real/);
    expect(chart).toMatch(/\?|unknown/i);
  });

  it('append 落盘保留 mode 字段', async () => {
    const tracker = new TrendTracker(workingDir);
    await tracker.append(makeTrendPoint({ mode: 'real' }));
    const raw = await readFile(path.join(workingDir, CONFIG_DIR_NEW, 'eval-trend.json'), 'utf-8');
    expect(JSON.parse(raw)[0].mode).toBe('real');
  });
});

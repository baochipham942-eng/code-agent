// ============================================================================
// regressionCache tests — V3-γ Multi-Eval Parallelism
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getOrRun,
  computeCacheHash,
} from '../../../../src/main/evaluation/regression/regressionCache';
import type { RegressionReport } from '../../../../src/main/evaluation/regression/regressionTypes';

function makeReport(passRate = 1.0): RegressionReport {
  return {
    runId: 'test-run-id',
    timestamp: '2026-04-10T00:00:00Z',
    totalCases: 5,
    passed: Math.round(passRate * 5),
    failed: Math.round((1 - passRate) * 5),
    errored: 0,
    passRate,
    results: [],
    durationMs: 1000,
  };
}

describe('computeCacheHash', () => {
  it('returns stable hash for same inputs', () => {
    const h1 = computeCacheHash(['a', 'b'], ['content1']);
    const h2 = computeCacheHash(['a', 'b'], ['content1']);
    expect(h1).toBe(h2);
  });

  it('returns same hash regardless of case ID order (sorted internally)', () => {
    const h1 = computeCacheHash(['b', 'a'], ['x']);
    const h2 = computeCacheHash(['a', 'b'], ['x']);
    expect(h1).toBe(h2);
  });

  it('returns different hash for different case IDs', () => {
    const h1 = computeCacheHash(['a', 'b'], ['x']);
    const h2 = computeCacheHash(['a', 'c'], ['x']);
    expect(h1).not.toBe(h2);
  });

  it('returns different hash for different rule contents', () => {
    const h1 = computeCacheHash(['a'], ['rule-v1']);
    const h2 = computeCacheHash(['a'], ['rule-v2']);
    expect(h1).not.toBe(h2);
  });
});

describe('getOrRun', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'regcache-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('calls runFn on cache miss and caches the result', async () => {
    const report = makeReport(0.8);
    const runFn = vi.fn().mockResolvedValue(report);

    const result = await getOrRun(['case-1'], ['rule-a'], runFn, {
      cacheDir: tmpDir,
    });

    expect(result).toEqual(report);
    expect(runFn).toHaveBeenCalledTimes(1);

    // 验证缓存文件已写入
    const files = await fs.readdir(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^baseline-.*\.json$/);
  });

  it('returns cached result on cache hit (does not call runFn again)', async () => {
    const report = makeReport(0.9);
    const runFn = vi.fn().mockResolvedValue(report);

    // 第一次调用：写入缓存
    await getOrRun(['c1'], ['r1'], runFn, { cacheDir: tmpDir });
    expect(runFn).toHaveBeenCalledTimes(1);

    // 第二次调用：应该命中缓存
    const runFn2 = vi.fn().mockResolvedValue(makeReport(0.5));
    const result2 = await getOrRun(['c1'], ['r1'], runFn2, { cacheDir: tmpDir });

    expect(runFn2).not.toHaveBeenCalled();
    expect(result2).toEqual(report); // 返回的是缓存中的旧报告
  });

  it('re-runs when cache has expired (TTL)', async () => {
    const oldReport = makeReport(0.7);
    const runFn1 = vi.fn().mockResolvedValue(oldReport);

    // 写入缓存
    await getOrRun(['c1'], ['r1'], runFn1, { cacheDir: tmpDir });

    // 手动修改缓存的 cachedAt 为 25 小时前
    const files = await fs.readdir(tmpDir);
    const cachePath = path.join(tmpDir, files[0]);
    const entry = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    entry.cachedAt = Date.now() - 25 * 60 * 60 * 1000;
    await fs.writeFile(cachePath, JSON.stringify(entry), 'utf8');

    // 再次调用：缓存过期，应该重新运行
    const newReport = makeReport(0.95);
    const runFn2 = vi.fn().mockResolvedValue(newReport);
    const result = await getOrRun(['c1'], ['r1'], runFn2, { cacheDir: tmpDir });

    expect(runFn2).toHaveBeenCalledTimes(1);
    expect(result).toEqual(newReport);
  });

  it('handles corrupt cache file gracefully', async () => {
    // 写入损坏的缓存
    const hash = computeCacheHash(['c1'], ['r1']);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, `baseline-${hash}.json`),
      'not valid json!',
      'utf8',
    );

    const report = makeReport(1.0);
    const runFn = vi.fn().mockResolvedValue(report);
    const result = await getOrRun(['c1'], ['r1'], runFn, { cacheDir: tmpDir });

    expect(runFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual(report);
  });

  it('respects custom TTL', async () => {
    const report = makeReport(0.8);
    const runFn = vi.fn().mockResolvedValue(report);

    // 写入缓存，TTL = 1ms
    await getOrRun(['c1'], ['r1'], runFn, {
      cacheDir: tmpDir,
      ttlMs: 1,
    });

    // 等待 TTL 过期
    await new Promise((r) => setTimeout(r, 5));

    const runFn2 = vi.fn().mockResolvedValue(makeReport(0.6));
    await getOrRun(['c1'], ['r1'], runFn2, {
      cacheDir: tmpDir,
      ttlMs: 1,
    });

    expect(runFn2).toHaveBeenCalledTimes(1);
  });
});

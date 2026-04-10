// ============================================================================
// Regression Baseline Cache — V3-γ Multi-Eval Parallelism
//
// 文件缓存：基于 eval case ID + rule 内容的哈希。
// 缓存路径: ~/.claude/eval-cache/baseline-<hash>.json
// TTL 默认 24 小时。
// ============================================================================

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import type { RegressionReport } from './regressionTypes';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface CacheOptions {
  cacheDir?: string;
  ttlMs?: number;
}

interface CacheEntry {
  report: RegressionReport;
  cachedAt: number; // Date.now() at write time
}

export function defaultCacheDir(): string {
  return path.join(os.homedir(), '.claude', 'eval-cache');
}

/**
 * 生成稳定哈希：sorted case IDs + rule 文件内容
 */
export function computeCacheHash(caseIds: string[], ruleContents: string[]): string {
  const h = createHash('sha256');
  for (const id of [...caseIds].sort()) {
    h.update(id);
  }
  for (const content of ruleContents) {
    h.update(content);
  }
  return h.digest('hex').slice(0, 16);
}

function cacheFilePath(dir: string, hash: string): string {
  return path.join(dir, `baseline-${hash}.json`);
}

export async function getOrRun(
  caseIds: string[],
  ruleContents: string[],
  runFn: () => Promise<RegressionReport>,
  opts: CacheOptions = {},
): Promise<RegressionReport> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const hash = computeCacheHash(caseIds, ruleContents);
  const filePath = cacheFilePath(cacheDir, hash);

  // 尝试读取缓存
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.cachedAt < ttlMs) {
      return entry.report;
    }
    // 过期，继续 fall through 重新运行
  } catch {
    // 缓存不存在或格式错误，fall through
  }

  // 运行并写入缓存
  const report = await runFn();
  const entry: CacheEntry = { report, cachedAt: Date.now() };

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf8');

  return report;
}

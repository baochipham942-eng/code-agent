// ============================================================================
// Repo Map Cache — git diff 增量更新 + 内存缓存
// ============================================================================

import { execSync } from 'child_process';
import * as path from 'path';
import type { RepoMapConfig, RepoMapCacheState, RepoMapResult } from './types';
import { buildRepoMap } from './repoMapBuilder';
import { rankAndFormat } from './repoMapRanker';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('RepoMapCache');

// 缓存有效期：5 分钟（与 prompt caching TTL 对齐）
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 单例缓存实例（per rootDir） */
const cacheInstances = new Map<string, RepoMapCacheState>();

/** 获取 git diff 中变更的文件列表 */
function getChangedFiles(rootDir: string, sinceMs: number): string[] {
  try {
    // 用 git status 获取工作区变更（未提交的）
    const statusOutput = execSync('git status --porcelain --no-renames', {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 5000,
    });

    const files: string[] = [];
    for (const line of statusOutput.split('\n')) {
      if (!line.trim()) continue;
      // git status 格式: XY filename
      const filePath = line.substring(3).trim();
      if (filePath) files.push(filePath);
    }

    // 也检查最近的 commit 变更
    try {
      const sinceDate = new Date(sinceMs).toISOString();
      const logOutput = execSync(`git log --name-only --format="" --since="${sinceDate}"`, {
        cwd: rootDir,
        encoding: 'utf-8',
        timeout: 5000,
      });
      for (const line of logOutput.split('\n')) {
        if (line.trim()) files.push(line.trim());
      }
    } catch {
      // 非 git 仓库或无 HEAD 时忽略
    }

    return [...new Set(files)];
  } catch {
    // 非 git 仓库，返回空
    return [];
  }
}

/** 获取或创建缓存实例 */
function getCacheState(rootDir: string): RepoMapCacheState {
  const normalized = path.resolve(rootDir);
  let state = cacheInstances.get(normalized);
  if (!state) {
    state = {
      entries: new Map(),
      lastFullBuild: 0,
      lastIncrementalUpdate: 0,
      rootDir: normalized,
    };
    cacheInstances.set(normalized, state);
  }
  return state;
}

/** 检查缓存是否过期 */
function isCacheValid(state: RepoMapCacheState): boolean {
  if (state.entries.size === 0) return false;
  const age = Date.now() - state.lastFullBuild;
  return age < CACHE_TTL_MS;
}

/**
 * 获取 Repo Map（带缓存）
 *
 * 策略：
 * 1. 缓存未过期 → 直接用缓存 + git diff 增量更新
 * 2. 缓存过期 → 全量重建
 */
export async function getRepoMap(config: RepoMapConfig): Promise<RepoMapResult> {
  const state = getCacheState(config.rootDir);
  const now = Date.now();

  if (isCacheValid(state)) {
    // 增量更新：只重建变更的文件
    const changedFiles = getChangedFiles(state.rootDir, state.lastIncrementalUpdate);

    if (changedFiles.length > 0) {
      logger.debug(`RepoMap: incremental update for ${changedFiles.length} changed files`);
      // 对变更文件重新构建 entry
      const updatedEntries = await buildRepoMap({
        ...config,
        patterns: changedFiles,
        maxFiles: changedFiles.length,
      });

      for (const [filePath, entry] of updatedEntries) {
        state.entries.set(filePath, entry);
      }

      // 删除已不存在的文件
      for (const filePath of changedFiles) {
        if (!updatedEntries.has(filePath)) {
          state.entries.delete(filePath);
        }
      }

      state.lastIncrementalUpdate = now;
    }
  } else {
    // 全量重建
    logger.info('RepoMap: full rebuild');
    const entries = await buildRepoMap(config);
    state.entries = entries;
    state.lastFullBuild = now;
    state.lastIncrementalUpdate = now;
  }

  return rankAndFormat(state.entries, config.tokenBudget);
}

/** 强制清除缓存（用于测试或手动刷新） */
export function invalidateRepoMapCache(rootDir?: string): void {
  if (rootDir) {
    cacheInstances.delete(path.resolve(rootDir));
  } else {
    cacheInstances.clear();
  }
}

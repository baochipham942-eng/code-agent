import path from 'path';
import { createRequire } from 'module';
import type BetterSqlite3 from 'better-sqlite3';
import type { createLogger } from '../../infra/logger';

type Logger = ReturnType<typeof createLogger>;

const runtimeRequire = typeof require === 'function' ? require : createRequire(import.meta.url);

/**
 * better-sqlite3 的候选 require 路径,按优先级排序。
 *
 * moduleDir 由调用方传入：必须以原 databaseService.ts 的位置为基准计算 native path,
 * 不能用本文件的 moduleDir, 否则打包后 ../native/ 会偏移到错误目录。
 *
 * 单独导出是因为 VACUUM 子进程(dbVacuumSubprocess.ts)要在**另一个 node 进程**里
 * 加载同一份 native binding —— 打包态 binding 在 dist/native/ 而非 node_modules,
 * 两处必须用同一份候选清单,否则子进程在打包态静默找不到 binding。
 */
export function betterSqlite3CandidatePaths(moduleDir: string): string[] {
  // Web/Tauri 模式: 系统 Node.js 运行，Electron ABI 的 .node 文件不兼容
  // 优先从 dist/native/ 加载为系统 Node 编译的版本
  return [
    path.join(moduleDir, '../native/better-sqlite3'),
    path.join(moduleDir, '../../native/better-sqlite3'),
    path.join(process.cwd(), 'dist/native/better-sqlite3'),
  ];
}

export function loadBetterSqlite3(moduleDir: string, logger: Logger): typeof BetterSqlite3 | null {
  if (process.env.CODE_AGENT_CLI_MODE && !process.env.CODE_AGENT_WEB_MODE) {
    return null;
  }

  let Database: typeof BetterSqlite3 | null = null;
  const nativePaths = betterSqlite3CandidatePaths(moduleDir);
  const candidateFailures: Array<{ path: string; error: string }> = [];
  for (const nativePath of nativePaths) {
    if (!Database) {
      try {
        const loaded: unknown = runtimeRequire(nativePath);
        Database = loaded as typeof BetterSqlite3;
        logger.info(`[DatabaseService] Loaded better-sqlite3 from ${nativePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
        candidateFailures.push({ path: nativePath, error: message });
        logger.debug(`[DatabaseService] better-sqlite3 candidate unavailable: ${nativePath}`, { error: message });
      }
    }
  }
  // 回退到默认路径（Electron 模式或 node_modules）
  if (!Database) {
    try {
      const loaded: unknown = runtimeRequire('better-sqlite3');
      Database = loaded as typeof BetterSqlite3;
      if (candidateFailures.length > 0) {
        logger.warn('[DatabaseService] Loaded better-sqlite3 from package fallback', {
          source: 'better-sqlite3',
          failedCandidates: candidateFailures,
        });
      }
    } catch (error) {
      const err = error as Error;
      logger.warn('[DatabaseService] better-sqlite3 unavailable after all load attempts', {
        failedCandidates: candidateFailures,
        fallbackError: err.message?.split('\n')[0],
      });
    }
  }
  return Database;
}

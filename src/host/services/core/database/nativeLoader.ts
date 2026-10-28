import path from 'path';
import { createRequire } from 'module';
import type BetterSqlite3 from 'better-sqlite3';
import type { createLogger } from '../../infra/logger';
import { readNativeDepManifest, resolveNativeDepEntry } from '../../../runtime/nativeDepManifest';

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
 *
 * loadBetterSqlite3 已按 ADR-086 T2 切到清单/包解析,不再消费本清单;
 * 两个子进程的交接(T3)退役本导出。
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

/**
 * better-sqlite3 装载(ADR-086 T2):
 * - bundle 模式(壳同时设 AGENT_NEO_BUNDLED_RUNTIME_ROOT/AGENT_NEO_RESOURCE_DIR):
 *   清单取单一 entry 路径 require 一次;清单缺失/声明路径缺失/平台不符直接 throw,无静默回退。
 * - 源码模式:直接 require('better-sqlite3') 纯包解析,零候选试探,不读 dist/native。
 *
 * moduleDir 参数保留不动(四个调用方不随本单改);子进程交接(T3)之前它只剩
 * betterSqlite3CandidatePaths 的调用方在用。
 */
export function loadBetterSqlite3(_moduleDir: string, logger: Logger): typeof BetterSqlite3 | null {
  if (process.env.CODE_AGENT_CLI_MODE && !process.env.CODE_AGENT_WEB_MODE) {
    return null;
  }

  const manifest = readNativeDepManifest(process.env, logger);
  if (!manifest) {
    try {
      const loaded: unknown = runtimeRequire('better-sqlite3');
      logger.debug('[DatabaseService] Loaded better-sqlite3 from package resolution (source mode)');
      return loaded as typeof BetterSqlite3;
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      logger.warn('[DatabaseService] better-sqlite3 unavailable in source mode', {
        fallbackError: message,
      });
      return null;
    }
  }

  const entryPath = resolveNativeDepEntry(manifest, 'better-sqlite3');
  const loaded: unknown = runtimeRequire(entryPath);
  logger.info(
    `[DatabaseService] Loaded better-sqlite3 from ${entryPath} via native dep manifest ${manifest.manifestPath}`,
  );
  return loaded as typeof BetterSqlite3;
}

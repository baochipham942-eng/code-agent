import { createRequire } from 'module';
import type BetterSqlite3 from 'better-sqlite3';
import type { createLogger } from '../../infra/logger';
import { readNativeDepManifest, resolveNativeDepEntry } from '../../../runtime/nativeDepManifest';

type Logger = ReturnType<typeof createLogger>;

const runtimeRequire = typeof require === 'function' ? require : createRequire(import.meta.url);

/**
 * 给 DB 子进程(quick_check / VACUUM)解析 better-sqlite3 的单一绝对路径(ADR-086 §4.3):
 * 一个进程一个决定 —— 父进程在这里解析一次,子进程只 require 收到的路径,不再重复试探。
 *
 * - bundle 模式: 清单 entry 的绝对路径,source 指名清单文件与模块 id;
 *   清单缺失/声明路径缺失/平台不符直接 throw(文案保持 ADR §4.4)。
 * - 源码模式: runtimeRequire.resolve 的绝对路径(与子进程 cwd 无关),
 *   source = "package resolution (source mode)"。
 */
export function resolveBetterSqlite3SubprocessPath(
  logger?: Logger,
): { path: string; source: string } {
  const manifest = readNativeDepManifest(process.env, logger);
  if (!manifest) {
    return {
      path: runtimeRequire.resolve('better-sqlite3'),
      source: 'package resolution (source mode)',
    };
  }
  return {
    path: resolveNativeDepEntry(manifest, 'better-sqlite3'),
    source: `native dep manifest ${manifest.manifestPath} (module 'better-sqlite3')`,
  };
}

/**
 * better-sqlite3 装载(ADR-086 T2):
 * - bundle 模式(壳同时设 AGENT_NEO_BUNDLED_RUNTIME_ROOT/AGENT_NEO_RESOURCE_DIR):
 *   清单取单一 entry 路径 require 一次;清单缺失/声明路径缺失/平台不符直接 throw,无静默回退。
 * - 源码模式:直接 require('better-sqlite3') 纯包解析,零候选试探,不读 dist/native。
 *
 * moduleDir 参数保留不动(四个调用方不随本单改);子进程交接见
 * resolveBetterSqlite3SubprocessPath。
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

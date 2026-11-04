/**
 * Tier 2 全量 PRAGMA quick_check —— 独立子进程。
 * 仿 dbVacuumSubprocess.ts：better-sqlite3 是同步 API，不能在 webServer 主线程全扫。
 *
 * native binding 路径由父进程经 resolveBetterSqlite3SubprocessPath 解析一次
 * (bundle 态走 dist/native 清单,源码态走包解析,ADR-086 §4.3)传给子进程;
 * 子进程单 require,失败 exit 3,不再持候选清单试探。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveBetterSqlite3SubprocessPath } from '../core/database/nativeLoader';
import { SQLITE_INTEGRITY } from '../../../shared/constants';
import { getUserDataPath } from '../../platform/appPaths';
import { createLogger } from './logger';
import {
  clearIntegrityFailedMarker,
  notifyIntegrityCheckResult,
  writeIntegrityFailedMarker,
} from '../core/database/integrityGate';

const logger = createLogger('DbQuickCheck');

const LOCK_FILE = '.quickcheck-running';
const EXIT_NATIVE_BINDING_UNRESOLVED = 3;
const EXIT_QUICK_CHECK_FAILED = 2;

export type QuickCheckOutcome =
  | 'ok'
  | 'failed'
  | 'not-due'
  | 'db-unavailable'
  | 'skipped-already-running'
  | 'spawn-failed';

export function shouldPersistIntegrityMarker(outcome: QuickCheckOutcome): boolean {
  return outcome === 'ok' || outcome === 'failed';
}

function lockPath(): string {
  return path.join(getUserDataPath(), LOCK_FILE);
}

function isAlreadyRunning(): boolean {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(lockPath(), 'utf8').trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 子进程不做任何路径试探:只 require 父进程解析好的那一个绝对路径(ADR-086 §4.3)。
const CHILD_SCRIPT = `
const nativePath = process.env.NEO_QUICKCHECK_NATIVE_PATH;
const nativeSource = process.env.NEO_QUICKCHECK_NATIVE_SOURCE || 'unknown';
let Database;
try {
  Database = require(nativePath);
} catch (error) {
  console.error('better-sqlite3 native binding unresolved at ' + nativePath + ' (' + nativeSource + '): ' + (error && error.message));
  process.exit(${EXIT_NATIVE_BINDING_UNRESOLVED});
}
console.error('native binding loaded from ' + nativePath);
const db = new Database(process.env.NEO_QUICKCHECK_DB_PATH, { readonly: true, fileMustExist: true });
try {
  db.pragma('busy_timeout = ' + Number(process.env.NEO_QUICKCHECK_BUSY_TIMEOUT_MS));
  const rows = db.pragma('quick_check');
  const lines = rows.map((row) => String(row.quick_check || ''));
  if (!(lines.length === 1 && lines[0] === 'ok')) {
    console.error(lines.join('\\n'));
    process.exit(${EXIT_QUICK_CHECK_FAILED});
  }
} finally {
  db.close();
}
`;

/**
 * 在独立子进程里跑 PRAGMA quick_check。永不抛。
 */
export async function runQuickCheckInSubprocess(dbPath: string): Promise<QuickCheckOutcome> {
  if (!fs.existsSync(dbPath)) return 'db-unavailable';
  if (isAlreadyRunning()) {
    logger.info('Database quick_check skipped: another subprocess is still running');
    return 'skipped-already-running';
  }

  const dataDir = path.dirname(dbPath);
  let nativePath: string;
  let nativeSource: string;
  try {
    const resolved = resolveBetterSqlite3SubprocessPath(logger);
    nativePath = resolved.path;
    nativeSource = resolved.source;
  } catch (error) {
    // 解析失败(清单缺失/声明路径缺失/平台不符)就不派子进程:错误文案自带清单条目信息
    logger.error(
      `Database quick_check could not resolve better-sqlite3: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'spawn-failed';
  }
  return await new Promise<QuickCheckOutcome>((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
      env: {
        ...process.env,
        NEO_QUICKCHECK_DB_PATH: dbPath,
        NEO_QUICKCHECK_NATIVE_PATH: nativePath,
        NEO_QUICKCHECK_NATIVE_SOURCE: nativeSource,
        NEO_QUICKCHECK_BUSY_TIMEOUT_MS: String(SQLITE_INTEGRITY.QUICK_CHECK_BUSY_TIMEOUT_MS),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    });

    const startedAt = Date.now();
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    try {
      fs.writeFileSync(lockPath(), String(child.pid), 'utf8');
    } catch (error) {
      logger.warn('Failed to write quick_check lock file (continuing)', error as Error);
    }

    const timer = setTimeout(() => {
      logger.warn(`Database quick_check timed out after ${SQLITE_INTEGRITY.QUICK_CHECK_TIMEOUT_MS}ms; killing pid ${child.pid}`);
      child.kill('SIGKILL');
    }, SQLITE_INTEGRITY.QUICK_CHECK_TIMEOUT_MS);

    const settle = (outcome: QuickCheckOutcome): void => {
      clearTimeout(timer);
      try {
        fs.rmSync(lockPath(), { force: true });
      } catch { /* next run probes pid */ }
      if (outcome === 'failed') {
        writeIntegrityFailedMarker(dataDir, Date.now());
        notifyIntegrityCheckResult({ ok: false, detail: stderr.trim() || undefined });
      } else if (outcome === 'ok') {
        clearIntegrityFailedMarker(dataDir);
        notifyIntegrityCheckResult({ ok: true });
      }
      resolve(outcome);
    };

    child.on('error', (error) => {
      logger.error('Database quick_check subprocess failed to spawn', error);
      settle('spawn-failed');
    });

    child.on('close', (code, signal) => {
      const elapsed = Date.now() - startedAt;
      if (code === 0) {
        logger.info(`Database quick_check ok (pid ${child.pid}, ${elapsed}ms)`, {
          childStderr: stderr.trim() || undefined,
        });
        settle('ok');
        return;
      }
      if (code === EXIT_QUICK_CHECK_FAILED) {
        logger.warn(`Database quick_check failed (${elapsed}ms): ${stderr.trim()}`);
        settle('failed');
        return;
      }
      if (code === EXIT_NATIVE_BINDING_UNRESOLVED) {
        logger.error(
          `Database quick_check could not resolve better-sqlite3 at ${nativePath} (${nativeSource}) :: ${stderr.trim()}`,
        );
        settle('spawn-failed');
        return;
      }
      logger.warn(
        `Database quick_check subprocess exited abnormally (code=${code}, signal=${signal}, ${elapsed}ms): ${stderr.trim()}`,
      );
      settle('spawn-failed');
    });
  });
}

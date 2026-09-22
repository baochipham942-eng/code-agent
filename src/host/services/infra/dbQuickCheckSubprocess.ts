/**
 * Tier 2 全量 PRAGMA quick_check —— 独立子进程。
 * 仿 dbVacuumSubprocess.ts：better-sqlite3 是同步 API，不能在 webServer 主线程全扫。
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { betterSqlite3CandidatePaths } from '../core/database/nativeLoader';
import { SQLITE_INTEGRITY } from '../../../shared/constants';
import { getUserDataPath } from '../../platform/appPaths';
import { createLogger } from './logger';
import {
  clearIntegrityFailedMarker,
  notifyIntegrityCheckResult,
  writeIntegrityFailedMarker,
} from '../core/database/integrityGate';

const logger = createLogger('DbQuickCheck');
const moduleDir = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

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

const CHILD_SCRIPT = `
const candidates = JSON.parse(process.env.NEO_QUICKCHECK_NATIVE_CANDIDATES || '[]');
let Database = null;
let loadedFrom = null;
for (const candidate of candidates) {
  try {
    Database = require(candidate);
    loadedFrom = candidate;
    break;
  } catch (error) {
    console.error('[quickcheck] native candidate unavailable: ' + candidate + ' :: ' + (error && error.message));
  }
}
if (!Database) {
  console.error('[quickcheck] better-sqlite3 native binding unresolved; tried: ' + candidates.join(', '));
  process.exit(${EXIT_NATIVE_BINDING_UNRESOLVED});
}
console.error('[quickcheck] native binding loaded from ' + loadedFrom);
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
  const candidates = [...betterSqlite3CandidatePaths(moduleDir), 'better-sqlite3'];
  return await new Promise<QuickCheckOutcome>((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
      env: {
        ...process.env,
        NEO_QUICKCHECK_DB_PATH: dbPath,
        NEO_QUICKCHECK_NATIVE_CANDIDATES: JSON.stringify(candidates),
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
        logger.info(`Database quick_check ok (pid ${child.pid}, ${elapsed}ms)`);
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
          `Database quick_check could not resolve better-sqlite3; tried: ${candidates.join(', ')} :: ${stderr.trim()}`,
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

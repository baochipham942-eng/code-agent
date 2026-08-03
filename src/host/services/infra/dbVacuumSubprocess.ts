// ============================================================================
// 全库 VACUUM —— 独立子进程执行
// ----------------------------------------------------------------------------
// 事故背景(2026-07-31):0.29.2 首启在 webServer 主线程里对 1.63GB 生产库同步跑
// VACUUM,把 listen 堵死 59.3 秒。better-sqlite3 是同步 API,`db.exec('VACUUM')`
// 阻塞整个 event loop —— 调用方 fire-and-forget(不 await)只避开了 await 语义,
// 避不开同步阻塞。
//
// 所以 VACUUM 必须离开 webServer 进程:这里用 process.execPath(打包态 = bundled
// node)跑一段最小脚本,主进程只 await 子进程退出码。
//
// 打包态最容易挂的点是 native binding:better-sqlite3 在打包态不在 node_modules,
// 而在 dist/native/better-sqlite3/。候选清单与主进程共用 nativeLoader 的同一份
// (betterSqlite3CandidatePaths),解析失败子进程以专用退出码退出、主进程记 error,
// 绝不静默跳过。
// ============================================================================

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { betterSqlite3CandidatePaths } from '../core/database/nativeLoader';
import { getUserDataPath } from '../../platform/appPaths';
import { TELEMETRY_RETENTION } from '../../../shared/constants';
import { createLogger } from './logger';

const logger = createLogger('DbVacuum');

const moduleDir = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

/** 正在跑的 VACUUM 子进程 pid 标记文件(存 pid 文本) */
const VACUUM_LOCK_FILE = '.vacuum-running';

/** 子进程 native binding 解析失败的专用退出码 */
const EXIT_NATIVE_BINDING_UNRESOLVED = 3;

export type VacuumOutcome =
  /** 子进程跑完,库已回收 */
  | 'completed'
  /** 节流未到,本次不该跑 */
  | 'not-due'
  /** DB 不可用(CLI 模式 / native module 缺失) */
  | 'db-unavailable'
  /** 可用磁盘不足 2.5x 库体积,跳过 */
  | 'skipped-low-disk'
  /** 已有 VACUUM 子进程在跑,跳过 */
  | 'skipped-already-running'
  /** 派出去了但失败(BUSY / native binding 缺失 / 超时),不落标记,下次启动再试 */
  | 'failed';

/** 只有 completed 才允许落 .last-vacuum 标记 */
export function shouldPersistVacuumMarker(outcome: VacuumOutcome): boolean {
  return outcome === 'completed';
}

function lockPath(): string {
  return path.join(getUserDataPath(), VACUUM_LOCK_FILE);
}

/**
 * 已有 VACUUM 子进程在跑?读 pid 标记并探活。
 * 标记存在但进程已死(上次崩溃留下的陈旧锁)视为没在跑。
 */
function isVacuumAlreadyRunning(): boolean {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(lockPath(), 'utf8').trim());
  } catch {
    return false; // 没有锁
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 只探活不发信号
    return true;
  } catch {
    return false; // 陈旧锁
  }
}

/** 可用磁盘是否够 VACUUM 用(全库重写 ≈ 一份副本 + WAL) */
async function hasFreeSpaceFor(dbPath: string): Promise<{ ok: boolean; detail: string }> {
  const dbBytes = (await fs.promises.stat(dbPath)).size;
  const required = Math.ceil(dbBytes * TELEMETRY_RETENTION.VACUUM_FREE_SPACE_FACTOR);
  const stats = await fs.promises.statfs(path.dirname(dbPath));
  const free = Number(stats.bavail) * Number(stats.bsize);
  return {
    ok: free >= required,
    detail: `db=${dbBytes}B required=${required}B free=${Math.round(free)}B`,
  };
}

// 子进程脚本:走 `node -e`,参数经 env 传入(避免 argv 引号歧义)。
// 只做三件事:加载 native binding → 开库设 busy_timeout → VACUUM → close。
// close() 是必须的:干净关闭才会 checkpoint 并删掉 -wal / -shm。
const CHILD_SCRIPT = `
const candidates = JSON.parse(process.env.NEO_VACUUM_NATIVE_CANDIDATES || '[]');
let Database = null;
let loadedFrom = null;
for (const candidate of candidates) {
  try {
    Database = require(candidate);
    loadedFrom = candidate;
    break;
  } catch (error) {
    console.error('[vacuum] native candidate unavailable: ' + candidate + ' :: ' + (error && error.message));
  }
}
if (!Database) {
  console.error('[vacuum] better-sqlite3 native binding unresolved; tried: ' + candidates.join(', '));
  process.exit(${EXIT_NATIVE_BINDING_UNRESOLVED});
}
console.error('[vacuum] native binding loaded from ' + loadedFrom);
const db = new Database(process.env.NEO_VACUUM_DB_PATH);
try {
  db.pragma('busy_timeout = ' + Number(process.env.NEO_VACUUM_BUSY_TIMEOUT_MS));
  db.exec('VACUUM');
} finally {
  db.close();
}
`;

/**
 * 在独立子进程里跑全库 VACUUM。永不抛：一切失败都映射成 outcome + 日志。
 *
 * 前置检查任一不满足都返回 skipped-* 并记 info 说明原因(不静默跳过)。
 */
export async function runVacuumInSubprocess(dbPath: string): Promise<VacuumOutcome> {
  if (isVacuumAlreadyRunning()) {
    logger.info('Database VACUUM skipped: another VACUUM subprocess is still running');
    return 'skipped-already-running';
  }

  try {
    const space = await hasFreeSpaceFor(dbPath);
    if (!space.ok) {
      logger.info(`Database VACUUM skipped: insufficient free disk space (${space.detail})`);
      return 'skipped-low-disk';
    }
  } catch (error) {
    // 探测不到磁盘/库信息就不冒险跑一个要 2x 空间的全库重写
    logger.info('Database VACUUM skipped: disk precheck failed', error as Error);
    return 'skipped-low-disk';
  }

  const candidates = [...betterSqlite3CandidatePaths(moduleDir), 'better-sqlite3'];
  return await new Promise<VacuumOutcome>((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
      env: {
        ...process.env,
        NEO_VACUUM_DB_PATH: dbPath,
        NEO_VACUUM_NATIVE_CANDIDATES: JSON.stringify(candidates),
        NEO_VACUUM_BUSY_TIMEOUT_MS: String(TELEMETRY_RETENTION.VACUUM_BUSY_TIMEOUT_MS),
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
      logger.warn('Failed to write VACUUM lock file (continuing)', error as Error);
    }

    const timer = setTimeout(() => {
      logger.warn(`Database VACUUM subprocess timed out after ${TELEMETRY_RETENTION.VACUUM_TIMEOUT_MS}ms; killing pid ${child.pid}`);
      child.kill('SIGKILL');
    }, TELEMETRY_RETENTION.VACUUM_TIMEOUT_MS);

    const settle = (outcome: VacuumOutcome): void => {
      clearTimeout(timer);
      try {
        fs.rmSync(lockPath(), { force: true });
      } catch { /* 锁清理失败不影响结果,下次靠 pid 探活兜底 */ }
      resolve(outcome);
    };

    child.on('error', (error) => {
      logger.error('Database VACUUM subprocess failed to spawn', error);
      settle('failed');
    });

    child.on('close', (code, signal) => {
      const elapsed = Date.now() - startedAt;
      if (code === 0) {
        logger.info(`Database VACUUM complete in subprocess (pid ${child.pid}, ${elapsed}ms)`, {
          childStderr: stderr.trim() || undefined,
        });
        settle('completed');
        return;
      }
      if (code === EXIT_NATIVE_BINDING_UNRESOLVED) {
        // 打包态最容易静默挂掉的地方:必须 error 级别报出来,不许当成普通 best-effort 失败
        logger.error(
          `Database VACUUM subprocess could not resolve the better-sqlite3 native binding; VACUUM will never run until this is fixed. Tried: ${candidates.join(', ')} :: ${stderr.trim()}`,
        );
        settle('failed');
        return;
      }
      logger.warn(
        `Database VACUUM subprocess exited abnormally (code=${code}, signal=${signal}, ${elapsed}ms): ${stderr.trim()}`,
      );
      settle('failed');
    });
  });
}

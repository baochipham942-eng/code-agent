/**
 * 主库备份轮转 + 坏库隔离。
 *
 * 损坏文件永不删除，只改名为 code-agent.db.corrupt-<ts>（连同 -wal/-shm）。
 * 备份轮转可以覆盖最旧的 backup-N（那是副本，不是损坏真源）。
 *
 * 双进程共写 data dir：恢复出的新库对仍在跑的旧进程不可见；旧进程继续写已经
 * 隔离改名的坏库。两边不会接到同一份文件上。重启后收敛到新库。不要把这份
 * 恢复出来的库当成「已经通知了旧进程」。
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type BetterSqlite3 from 'better-sqlite3';
import { SQLITE_INTEGRITY } from '../../../shared/constants';
import { loadBetterSqlite3 } from '../core/database/nativeLoader';
import { evaluateQuickCheck, hasIntegrityFailedMarker } from '../core/database/integrityGate';
import { createLogger } from './logger';

const logger = createLogger('DbBackup');
const moduleDir = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

export type BackupOutcome =
  | 'completed'
  | 'not-due'
  | 'skipped-low-disk'
  | 'skipped-integrity-failed'
  | 'skipped-no-db'
  | 'failed';

export interface RotateBackupOptions {
  dbPath: string;
  now?: number;
  force?: boolean;
  keep?: number;
  backupTo: (destPath: string) => Promise<void>;
  readLastBackupAt?: () => number | null;
  writeLastBackupAt?: (ts: number) => void;
  hasFreeSpace?: (dbPath: string) => Promise<{ ok: boolean; detail: string }>;
  /** 完整性失败判定(测试用);默认读 dataDir 的 .integrity-failed 标记 */
  integrityFailed?: () => boolean;
}

function backupSlotPath(dbPath: string, slot: number): string {
  return `${dbPath}.backup-${slot}`;
}

function listBackupSlotPaths(
  dbPath: string,
  keep = SQLITE_INTEGRITY.BACKUP_KEEP,
): string[] {
  const paths: string[] = [];
  for (let slot = 1; slot <= keep; slot += 1) {
    paths.push(backupSlotPath(dbPath, slot));
  }
  return paths;
}

function shouldRunBackup(now: number, lastBackupAt: number | null): boolean {
  if (lastBackupAt == null) return true;
  return now - lastBackupAt >= SQLITE_INTEGRITY.BACKUP_MIN_INTERVAL_MS;
}

function markerPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), SQLITE_INTEGRITY.MARKER_BACKUP);
}

function defaultReadLastBackupAt(dbPath: string): number | null {
  try {
    const raw = fs.readFileSync(markerPath(dbPath), 'utf8').trim();
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

function defaultWriteLastBackupAt(dbPath: string, ts: number): void {
  try {
    fs.writeFileSync(markerPath(dbPath), String(ts), 'utf8');
  } catch (error) {
    logger.warn('Failed to persist last-db-backup marker', error as Error);
  }
}

async function hasFreeSpaceForBackup(dbPath: string): Promise<{ ok: boolean; detail: string }> {
  const dbBytes = (await fs.promises.stat(dbPath)).size;
  const required = Math.ceil(dbBytes * SQLITE_INTEGRITY.BACKUP_FREE_SPACE_FACTOR);
  const stats = await fs.promises.statfs(path.dirname(dbPath));
  const free = Number(stats.bavail) * Number(stats.bsize);
  return {
    ok: free >= required,
    detail: `db=${dbBytes}B required=${required}B free=${Math.round(free)}B`,
  };
}

function rotateSlots(dbPath: string, keep: number, tmpPath: string): void {
  const oldest = backupSlotPath(dbPath, keep);
  if (fs.existsSync(oldest)) {
    fs.rmSync(oldest, { force: true });
  }
  for (let slot = keep; slot > 1; slot -= 1) {
    const newer = backupSlotPath(dbPath, slot - 1);
    if (fs.existsSync(newer)) {
      fs.renameSync(newer, backupSlotPath(dbPath, slot));
    }
  }
  fs.renameSync(tmpPath, backupSlotPath(dbPath, 1));
}

/**
 * 用 online backup API 落一份轮转副本。失败只报警不抛。
 */
export const rotateDatabaseBackup = Object.assign(
  async function rotateDatabaseBackup(options: RotateBackupOptions): Promise<BackupOutcome> {
  const now = options.now ?? Date.now();
  const keep = options.keep ?? SQLITE_INTEGRITY.BACKUP_KEEP;
  const readLast = options.readLastBackupAt ?? (() => defaultReadLastBackupAt(options.dbPath));
  const writeLast = options.writeLastBackupAt ?? ((ts: number) => defaultWriteLastBackupAt(options.dbPath, ts));

  // .integrity-failed 在 = 当前库可能带 Tier 1 看不见的页级损坏。此时轮转会用
  // 带坏库顶掉好备份,灾难性损坏时无好副本可恢复——force(VACUUM 前备份)也不豁免。
  // 标记只能由成功恢复 / Tier 2 复测通过清除,之后轮转自然恢复。
  const integrityFailed = options.integrityFailed
    ?? (() => hasIntegrityFailedMarker(path.dirname(options.dbPath)));
  if (integrityFailed()) {
    logger.warn('Database backup skipped: .integrity-failed marker set (not overwriting a good backup with a suspect db)');
    return 'skipped-integrity-failed';
  }

  if (!options.force && !shouldRunBackup(now, readLast())) {
    return 'not-due';
  }
  if (!fs.existsSync(options.dbPath)) {
    return 'skipped-no-db';
  }

  try {
    const space = await (options.hasFreeSpace ?? hasFreeSpaceForBackup)(options.dbPath);
    if (!space.ok) {
      logger.warn(`Database backup skipped: insufficient free disk space (${space.detail})`);
      return 'skipped-low-disk';
    }
  } catch (error) {
    logger.warn('Database backup skipped: disk precheck failed', error as Error);
    return 'skipped-low-disk';
  }

  const tmpPath = `${options.dbPath}.backup-tmp`;
  try {
    await options.backupTo(tmpPath);
    rotateSlots(options.dbPath, keep, tmpPath);
    writeLast(now);
    logger.info(`Database backup rotated (${backupSlotPath(options.dbPath, 1)})`);
    return 'completed';
  } catch (error) {
    logger.warn('Database backup failed', error as Error);
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    return 'failed';
  }
  },
  {
    // 测试用助手挂在既有导出上，不作为新 export（knip production 棘轮不认新死导出，见 ftsRepair 同款写法）。
    /** 测试用：备份节流判定 */
    shouldRunBackup,
    /** 测试用：轮转槽位路径 */
    backupSlotPath,
  },
);

/**
 * 坏库隔离改名。永不删除。
 * 双进程语义：旧进程的 fd 仍指向已改名文件，会继续写隔离后的坏库；
 * 本进程随后在原路径上打开恢复出的新库，旧进程看不见。重启后收敛。
 */
export function isolateCorruptDatabase(dbPath: string, now = Date.now()): string {
  const dest = `${dbPath}.corrupt-${now}`;
  for (const suffix of ['', '-wal', '-shm'] as const) {
    const src = `${dbPath}${suffix}`;
    if (!fs.existsSync(src)) continue;
    fs.renameSync(src, `${dest}${suffix}`);
  }
  return dest;
}

export function copyBackupIntoPlace(backupPath: string, dbPath: string): void {
  fs.copyFileSync(backupPath, dbPath);
}

export function quickCheckFileSync(dbPath: string): boolean {
  const Database = loadBetterSqlite3(moduleDir, logger);
  if (!Database) return false;
  let db: BetterSqlite3.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return evaluateQuickCheck(db).ok;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * 从最新到最旧找一份 quick_check 通过的备份。坏备份拒绝采纳，但不删除。
 */
export function findLatestGoodBackup(
  dbPath: string,
  isGood: (backupPath: string) => boolean = quickCheckFileSync,
  keep = SQLITE_INTEGRITY.BACKUP_KEEP,
): { path: string; mtimeMs: number } | null {
  for (const candidate of listBackupSlotPaths(dbPath, keep)) {
    if (!fs.existsSync(candidate)) continue;
    try {
      if (!isGood(candidate)) {
        logger.warn(`Rejecting corrupt backup (quick_check failed): ${candidate}`);
        continue;
      }
      return { path: candidate, mtimeMs: fs.statSync(candidate).mtimeMs };
    } catch (error) {
      logger.warn(`Backup candidate unreadable: ${candidate}`, error as Error);
    }
  }
  return null;
}

export function describeBackupStatus(dbPath: string, keep = SQLITE_INTEGRITY.BACKUP_KEEP): string {
  const parts: string[] = [];
  for (let slot = 1; slot <= keep; slot += 1) {
    const filePath = backupSlotPath(dbPath, slot);
    if (!fs.existsSync(filePath)) continue;
    try {
      const mtime = fs.statSync(filePath).mtime.toISOString();
      parts.push(`backup-${slot}@${mtime}`);
    } catch {
      parts.push(`backup-${slot}`);
    }
  }
  return parts.length > 0 ? `${parts.length} (${parts.join(', ')})` : 'none';
}

// ============================================================================
// DB Retention - 启动期本地数据库保留清理
// ----------------------------------------------------------------------------
// telemetry 聚合重量表原本无任何 TTL,随会话无限堆积(实测生产库到 377MB+,
// telemetry_events 62 万行占 163MB)。这里在启动期 best-effort 做两件事:
//   1) 按保留期删除过期 granular 明细行(pruneAgedTelemetry)——止血,便宜走索引
//   2) 节流的全库 VACUUM——回收 DELETE 释放的页(SQLite 不 VACUUM 不缩文件)
//
// VACUUM 走**独立子进程**(dbVacuumSubprocess.ts)。原因见 2026-07-31 事故:
// better-sqlite3 是同步 API,在本进程 exec('VACUUM') 会阻塞整个 event loop,
// 实测把 webServer 的 listen 堵死 59.3 秒 —— 调用方 fire-and-forget 挡不住,
// 那只避开了 await 语义,避不开同步阻塞。
//
// 与 logRetention 一样:任一环节失败都不抛,仅记 warn/info,并且**失败不落
// .last-vacuum 标记**,下次启动会再试。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getTelemetryStorage } from '../../telemetry/telemetryStorage';
import { getDatabase } from '../core/databaseService';
import { getUserDataPath } from '../../platform/appPaths';
import { SQLITE_INTEGRITY, TELEMETRY_RETENTION } from '../../../shared/constants';
import { createLogger } from './logger';
import { runVacuumInSubprocess, shouldPersistVacuumMarker, type VacuumOutcome } from './dbVacuumSubprocess';
import { rotateDatabaseBackup, type BackupOutcome } from './dbBackup';
import {
  runQuickCheckInSubprocess,
  shouldPersistIntegrityMarker,
  type QuickCheckOutcome,
} from './dbQuickCheckSubprocess';
import {
  readTimestampMarker,
  shouldRunIntegrityCheck,
  writeTimestampMarker,
  integrityMarkerPath,
} from '../core/database/integrityGate';

export type { VacuumOutcome };

const logger = createLogger('DbRetention');

/** 记录上次 VACUUM 时间戳的标记文件名(存 epoch ms 文本) */
const VACUUM_MARKER_FILE = '.last-vacuum';

/**
 * 是否该跑 VACUUM:从未跑过(null)必跑;否则距上次达到节流间隔才跑。
 */
export function shouldRunVacuum(now: number, lastVacuumAt: number | null): boolean {
  if (lastVacuumAt == null) return true;
  return now - lastVacuumAt >= TELEMETRY_RETENTION.VACUUM_MIN_INTERVAL_MS;
}

function defaultMarkerPath(): string {
  return path.join(getUserDataPath(), VACUUM_MARKER_FILE);
}

function defaultReadLastVacuumAt(): number | null {
  try {
    const raw = fs.readFileSync(defaultMarkerPath(), 'utf8').trim();
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null; // 标记不存在 = 从未 VACUUM
  }
}

function defaultWriteLastVacuumAt(ts: number): void {
  try {
    fs.writeFileSync(defaultMarkerPath(), String(ts), 'utf8');
  } catch (error) {
    logger.warn('Failed to persist last-vacuum marker', error as Error);
  }
}

function defaultVacuum(): Promise<VacuumOutcome> {
  return backupThenVacuum();
}

/**
 * VACUUM 子进程动刀前先落一份备份（2026-07-31 SIGBUS 事故的对症保险）。
 * 备份失败只报警，VACUUM 仍按自身磁盘检查决定是否继续。
 * .integrity-failed 在时 rotateDatabaseBackup 内部拒轮转（force 不豁免）：
 * 带坏库的备份会顶掉好副本。
 */
async function backupThenVacuum(): Promise<VacuumOutcome> {
  const database = getDatabase();
  const db = database.getDb();
  const dbPath = database.getDbPath();
  if (db) {
    try {
      await rotateDatabaseBackup({
        dbPath,
        force: true,
        backupTo: async (dest) => {
          await db.backup(dest);
        },
      });
    } catch (error) {
      logger.warn('Pre-VACUUM backup failed (continuing to VACUUM)', error as Error);
    }
  }
  return runVacuumInSubprocess(dbPath);
}

function defaultBackup(): Promise<BackupOutcome> {
  try {
    const database = getDatabase();
    const db = database.getDb();
    if (!db) return Promise.resolve('skipped-no-db');
    return rotateDatabaseBackup({
      dbPath: database.getDbPath(),
      backupTo: async (dest) => {
        await db.backup(dest);
      },
    });
  } catch {
    return Promise.resolve('skipped-no-db');
  }
}

function defaultIntegrityCheck(): Promise<QuickCheckOutcome> {
  try {
    const database = getDatabase();
    if (!database.getDb()) return Promise.resolve('db-unavailable');
    return runQuickCheckInSubprocess(database.getDbPath());
  } catch {
    return Promise.resolve('db-unavailable');
  }
}

function defaultReadLastIntegrityAt(): number | null {
  try {
    return readTimestampMarker(
      integrityMarkerPath(getUserDataPath(), SQLITE_INTEGRITY.MARKER_INTEGRITY),
    );
  } catch {
    return null;
  }
}

function defaultWriteLastIntegrityAt(ts: number): void {
  try {
    writeTimestampMarker(
      integrityMarkerPath(getUserDataPath(), SQLITE_INTEGRITY.MARKER_INTEGRITY),
      ts,
    );
  } catch (error) {
    logger.warn('Failed to persist last-integrity-check marker', error as Error);
  }
}

export interface DbRetentionOptions {
  /** 当前时间(测试用) */
  now?: number;
  /** 覆盖 telemetry 存储(测试用) */
  storage?: { dbAvailable: boolean; pruneAgedTelemetry(now: number): void };
  /** 覆盖 VACUUM 实现(测试用)。返回 outcome,不抛 */
  vacuum?: () => Promise<VacuumOutcome>;
  readLastVacuumAt?: () => number | null;
  writeLastVacuumAt?: (ts: number) => void;
  backup?: () => Promise<BackupOutcome>;
  integrityCheck?: () => Promise<QuickCheckOutcome>;
  readLastIntegrityAt?: () => number | null;
  writeLastIntegrityAt?: (ts: number) => void;
  /** 上次 Tier 2 quick_check 失败标记(测试 seam);生产默认由 rotateDatabaseBackup 内部读标记兜底 */
  hasIntegrityFailed?: () => boolean;
}

export interface DbRetentionResult {
  pruned: boolean;
  /**
   * VACUUM 结果。**不要用真值判断当成功**:only 'completed' 表示库真的被回收了,
   * 'skipped-*' / 'failed' 都没有落 .last-vacuum 标记,下次启动会再试。
   */
  vacuum: VacuumOutcome;
  backup: BackupOutcome;
  integrityCheck: QuickCheckOutcome;
}

/**
 * 启动期数据库保留清理。best-effort:先删过期明细,再节流 VACUUM(子进程)。
 */
export async function runDbRetention(options: DbRetentionOptions = {}): Promise<DbRetentionResult> {
  const now = options.now ?? Date.now();
  const storage = options.storage ?? getTelemetryStorage();
  const vacuum = options.vacuum ?? defaultVacuum;
  const backup = options.backup ?? defaultBackup;
  const integrityCheck = options.integrityCheck ?? defaultIntegrityCheck;
  const readLastVacuumAt = options.readLastVacuumAt ?? defaultReadLastVacuumAt;
  const writeLastVacuumAt = options.writeLastVacuumAt ?? defaultWriteLastVacuumAt;
  const readLastIntegrityAt = options.readLastIntegrityAt ?? defaultReadLastIntegrityAt;
  const writeLastIntegrityAt = options.writeLastIntegrityAt ?? defaultWriteLastIntegrityAt;

  let pruned = false;
  try {
    storage.pruneAgedTelemetry(now);
    pruned = true;
  } catch (error) {
    logger.warn('Aged telemetry prune failed', error as Error);
  }

  if (!storage.dbAvailable) {
    logger.info('Database VACUUM skipped: persistence unavailable');
    return { pruned, vacuum: 'db-unavailable', backup: 'skipped-no-db', integrityCheck: 'db-unavailable' };
  }

  // quick_check 结果先行:备份门要看本次结果——带坏库轮转会顶掉好备份。
  let integrityOutcome: QuickCheckOutcome = 'not-due';
  if (shouldRunIntegrityCheck(now, readLastIntegrityAt())) {
    try {
      integrityOutcome = await integrityCheck();
    } catch (error) {
      logger.warn('Database quick_check failed', error as Error);
      integrityOutcome = 'spawn-failed';
    }
    if (shouldPersistIntegrityMarker(integrityOutcome)) {
      writeLastIntegrityAt(now);
    }
  }

  // 本次 quick_check 失败或 .integrity-failed 标记还在:跳过备份轮转,
  // 不用可能带页级损坏的当前库顶掉好备份(VACUUM 前备份在 rotateDatabaseBackup 内过同一门)。
  const integrityFailed = integrityOutcome === 'failed' || (options.hasIntegrityFailed?.() ?? false);
  let backupOutcome: BackupOutcome;
  if (integrityFailed) {
    logger.warn('Database backup skipped: integrity check failed (keeping existing good backups)');
    backupOutcome = 'skipped-integrity-failed';
  } else {
    try {
      backupOutcome = await backup();
    } catch (error) {
      logger.warn('Database backup failed', error as Error);
      backupOutcome = 'failed';
    }
  }

  let vacuumOutcome: VacuumOutcome = 'not-due';
  if (shouldRunVacuum(now, readLastVacuumAt())) {
    try {
      vacuumOutcome = await vacuum();
    } catch (error) {
      // runVacuumInSubprocess 承诺不抛;这里只兜注入实现 / 意外异常
      logger.warn('Database VACUUM failed', error as Error);
      vacuumOutcome = 'failed';
    }
    if (shouldPersistVacuumMarker(vacuumOutcome)) {
      writeLastVacuumAt(now);
    }
  }

  return { pruned, vacuum: vacuumOutcome, backup: backupOutcome, integrityCheck: integrityOutcome };
}

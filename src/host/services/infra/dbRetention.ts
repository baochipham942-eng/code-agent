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
import { TELEMETRY_RETENTION } from '../../../shared/constants';
import { createLogger } from './logger';
import { runVacuumInSubprocess, shouldPersistVacuumMarker, type VacuumOutcome } from './dbVacuumSubprocess';

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
  return runVacuumInSubprocess(getDatabase().getDbPath());
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
}

export interface DbRetentionResult {
  pruned: boolean;
  /**
   * VACUUM 结果。**不要用真值判断当成功**:only 'completed' 表示库真的被回收了,
   * 'skipped-*' / 'failed' 都没有落 .last-vacuum 标记,下次启动会再试。
   */
  vacuum: VacuumOutcome;
}

/**
 * 启动期数据库保留清理。best-effort:先删过期明细,再节流 VACUUM(子进程)。
 */
export async function runDbRetention(options: DbRetentionOptions = {}): Promise<DbRetentionResult> {
  const now = options.now ?? Date.now();
  const storage = options.storage ?? getTelemetryStorage();
  const vacuum = options.vacuum ?? defaultVacuum;
  const readLastVacuumAt = options.readLastVacuumAt ?? defaultReadLastVacuumAt;
  const writeLastVacuumAt = options.writeLastVacuumAt ?? defaultWriteLastVacuumAt;

  let pruned = false;
  try {
    storage.pruneAgedTelemetry(now);
    pruned = true;
  } catch (error) {
    logger.warn('Aged telemetry prune failed', error as Error);
  }

  if (!storage.dbAvailable) {
    logger.info('Database VACUUM skipped: persistence unavailable');
    return { pruned, vacuum: 'db-unavailable' };
  }
  if (!shouldRunVacuum(now, readLastVacuumAt())) {
    return { pruned, vacuum: 'not-due' };
  }

  let outcome: VacuumOutcome;
  try {
    outcome = await vacuum();
  } catch (error) {
    // runVacuumInSubprocess 承诺不抛;这里只兜注入实现 / 意外异常
    logger.warn('Database VACUUM failed', error as Error);
    outcome = 'failed';
  }

  if (shouldPersistVacuumMarker(outcome)) {
    writeLastVacuumAt(now);
  }
  return { pruned, vacuum: outcome };
}

// ============================================================================
// DB Retention - 启动期本地数据库保留清理
// ----------------------------------------------------------------------------
// telemetry 聚合重量表原本无任何 TTL,随会话无限堆积(实测生产库到 377MB+,
// telemetry_events 62 万行占 163MB)。这里在启动期 best-effort 做两件事:
//   1) 按保留期删除过期 granular 明细行(pruneAgedTelemetry)——止血,便宜走索引
//   2) 节流的全库 VACUUM——回收 DELETE 释放的页(SQLite 不 VACUUM 不缩文件)
// VACUUM 是全库重写、better-sqlite3 同步阻塞、需 2x 临时磁盘,故按
// VACUUM_MIN_INTERVAL_MS 节流,并由调用方 fire-and-forget 放到启动关键路径之后跑。
// 与 logRetention 一样:任一环节失败都不抛,仅记 warn。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getTelemetryStorage } from '../../telemetry/telemetryStorage';
import { getDatabase } from '../core/databaseService';
import { getUserDataPath } from '../../platform/appPaths';
import { TELEMETRY_RETENTION } from '../../../shared/constants';
import { createLogger } from './logger';

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

function defaultVacuum(): void {
  const db = getDatabase().getDb();
  if (!db) return;
  db.exec('VACUUM');
}

export interface DbRetentionOptions {
  /** 当前时间(测试用) */
  now?: number;
  /** 覆盖 telemetry 存储(测试用) */
  storage?: { dbAvailable: boolean; pruneAgedTelemetry(now: number): void };
  /** 覆盖 VACUUM 实现(测试用) */
  vacuum?: () => void;
  readLastVacuumAt?: () => number | null;
  writeLastVacuumAt?: (ts: number) => void;
}

export interface DbRetentionResult {
  pruned: boolean;
  vacuumed: boolean;
}

/**
 * 启动期数据库保留清理。best-effort:先删过期明细,再节流 VACUUM。
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

  let vacuumed = false;
  if (storage.dbAvailable && shouldRunVacuum(now, readLastVacuumAt())) {
    try {
      vacuum();
      writeLastVacuumAt(now);
      vacuumed = true;
      logger.info('Database VACUUM complete');
    } catch (error) {
      logger.warn('Database VACUUM failed', error as Error);
    }
  }

  return { pruned, vacuumed };
}

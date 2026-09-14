/**
 * 启动完整性探针（Tier 1 同步 + Tier 2 异步调度入口）。
 *
 * 🔴 不许把全量 PRAGMA integrity_check / quick_check 塞进 init 同步路径。
 * 生产库 1.28–1.6GB，全扫是秒级到十几秒，会拖垮 health-ready。
 * Tier 1 只读 sqlite_master + 对关键表 SELECT … LIMIT 1，逐表包裹。
 * Tier 2 全量 quick_check 走 dbQuickCheckSubprocess，init 之后节流跑。
 */

import * as fs from 'fs';
import * as path from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import { SQLITE_INTEGRITY } from '../../../../shared/constants';
import { classifySqliteIntegrityError, readSqliteErrorCode } from './sqliteErrors';

const INTEGRITY_CRITICAL_TABLES = [
  'sessions',
  'messages',
  'memories',
  'durable_runs',
  'permission_decisions',
  'tool_execution_events',
  'swarm_run_ledger',
  'usage_ledger',
  'turn_cost_estimates',
] as const;

type IntegritySeverity = 'ok' | 'local' | 'catastrophic';

interface TableProbeResult {
  table: string;
  ok: boolean;
  errorCode?: string;
}

export interface IntegrityProbeResult {
  severity: IntegritySeverity;
  sqliteMasterOk: boolean;
  tables: TableProbeResult[];
  elapsedMs: number;
}

export type DbIntegrityOutcome =
  | { kind: 'ok' }
  | { kind: 'recovered'; backupTakenAt: number; isolatedPath: string }
  | { kind: 'local'; tables: string[] }
  | { kind: 'degraded'; reason: string };

export type IntegrityCheckListener = (result: { ok: boolean; detail?: string }) => void;

let integrityCheckListener: IntegrityCheckListener | null = null;

export function setIntegrityCheckListener(listener: IntegrityCheckListener | null): void {
  integrityCheckListener = listener;
}

export function notifyIntegrityCheckResult(result: { ok: boolean; detail?: string }): void {
  try {
    integrityCheckListener?.(result);
  } catch {
    // 监听失败只报警不抛：修复失败只报警不抛。
  }
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * 在已打开连接上跑 PRAGMA quick_check。
 * 只给备份校验 / 子进程 / 测试用，禁止从 _doInitialize 同步路径调用。
 */
export function evaluateQuickCheck(db: BetterSqlite3.Database): { ok: boolean; detail: string } {
  try {
    const rows = db.pragma('quick_check') as Array<{ quick_check?: unknown }>;
    const lines = rows.map((row) => String(row.quick_check ?? ''));
    const ok = lines.length === 1 && lines[0] === 'ok';
    return { ok, detail: lines.join('\n') };
  } catch (err) {
    const code = readSqliteErrorCode(err);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: code ? `${code}: ${message}` : message };
  }
}

function existingTableNames(db: BetterSqlite3.Database): Set<string> | 'catastrophic' | 'uncertain' {
  try {
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).all() as Array<{ name?: unknown }>;
    return new Set(
      rows
        .map((row) => (typeof row.name === 'string' ? row.name : ''))
        .filter((name) => name.length > 0),
    );
  } catch (err) {
    if (classifySqliteIntegrityError(err) === 'corrupt') return 'catastrophic';
    // 临时/无法归类的 IOERR:拿不准,不当成损坏、不隔离
    return 'uncertain';
  }
}

/**
 * Tier 1 结构探针。空库 / 尚未 applySchema 的表记为跳过，不是损坏。
 * 只有真损坏(SQLITE_CORRUPT / SQLITE_NOTADB / malformed)才记损坏;
 * 临时 IOERR 与其他异常拿不准,不当成损坏、不隔离。
 */
export const probeDatabaseIntegrity = Object.assign(
  function probeDatabaseIntegrity(db: BetterSqlite3.Database): IntegrityProbeResult {
  const started = performance.now();
  try {
    db.prepare('SELECT name, type FROM sqlite_master LIMIT 1').get();
  } catch (err) {
    if (classifySqliteIntegrityError(err) === 'corrupt') {
      return {
        severity: 'catastrophic',
        sqliteMasterOk: false,
        tables: [],
        elapsedMs: performance.now() - started,
      };
    }
    return {
      severity: 'ok',
      sqliteMasterOk: false,
      tables: [],
      elapsedMs: performance.now() - started,
    };
  }

  const existing = existingTableNames(db);
  if (existing === 'catastrophic') {
    return {
      severity: 'catastrophic',
      sqliteMasterOk: false,
      tables: [],
      elapsedMs: performance.now() - started,
    };
  }
  if (existing === 'uncertain') {
    return {
      severity: 'ok',
      sqliteMasterOk: true,
      tables: [],
      elapsedMs: performance.now() - started,
    };
  }

  const tables: TableProbeResult[] = [];
  for (const table of INTEGRITY_CRITICAL_TABLES) {
    if (!existing.has(table)) continue;
    try {
      db.prepare(`SELECT 1 FROM ${quoteIdent(table)} LIMIT 1`).get();
      tables.push({ table, ok: true });
    } catch (err) {
      if (classifySqliteIntegrityError(err) === 'corrupt') {
        tables.push({
          table,
          ok: false,
          errorCode: readSqliteErrorCode(err) || 'SQLITE_CORRUPT',
        });
      } else {
        // 临时 IOERR(SHMMAP/LOCK/FSYNC…)或无关错误:表未必坏,不记损坏
        tables.push({ table, ok: true });
      }
    }
  }

  const failed = tables.filter((row) => !row.ok);
  return {
    severity: failed.length > 0 ? 'local' : 'ok',
    sqliteMasterOk: true,
    tables,
    elapsedMs: performance.now() - started,
  };
  },
  {
    // 测试用助手挂在既有导出上，不作为新 export（knip production 棘轮不认新死导出，见 ftsRepair 同款写法）。
    /** 测试用：Tier 1 逐表探针的关键表清单 */
    CRITICAL_TABLES: INTEGRITY_CRITICAL_TABLES,
  },
);

/**
 * 灾难性损坏始终尝试恢复；.integrity-failed 在（上次 Tier 2 quick_check 判过失败）时
 * local 与 ok 都升级为尝试恢复——Tier 2 全扫的判决优先于 Tier 1 浅探针（方案档 §2.1:
 * 「下次启动 Tier 1 升级为尝试恢复」)。Tier 1 通过无权清标记。
 */
export function shouldAttemptRestore(
  probe: IntegrityProbeResult,
  options: { escalate: boolean },
): boolean {
  if (probe.severity === 'catastrophic') return true;
  return options.escalate;
}

export function integrityMarkerPath(dataDir: string, fileName: string): string {
  return path.join(dataDir, fileName);
}

export function readTimestampMarker(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

export function writeTimestampMarker(filePath: string, ts: number): void {
  fs.writeFileSync(filePath, String(ts), 'utf8');
}

export function shouldRunIntegrityCheck(now: number, lastCheckAt: number | null): boolean {
  if (lastCheckAt == null) return true;
  return now - lastCheckAt >= SQLITE_INTEGRITY.QUICK_CHECK_MIN_INTERVAL_MS;
}

export function hasIntegrityFailedMarker(dataDir: string): boolean {
  return fs.existsSync(integrityMarkerPath(dataDir, SQLITE_INTEGRITY.MARKER_INTEGRITY_FAILED));
}

export function writeIntegrityFailedMarker(dataDir: string, now: number): void {
  try {
    writeTimestampMarker(
      integrityMarkerPath(dataDir, SQLITE_INTEGRITY.MARKER_INTEGRITY_FAILED),
      now,
    );
  } catch {
    // 标记写失败只报警不抛
  }
}

export function clearIntegrityFailedMarker(dataDir: string): void {
  try {
    fs.rmSync(integrityMarkerPath(dataDir, SQLITE_INTEGRITY.MARKER_INTEGRITY_FAILED), { force: true });
  } catch {
    // ignore
  }
}

/** 自愈口子:恢复成功后清除不可恢复标记(见 databaseService 启动时的重试恢复)。 */
export function clearUnrecoverableMarker(dataDir: string): void {
  try {
    fs.rmSync(integrityMarkerPath(dataDir, SQLITE_INTEGRITY.MARKER_UNRECOVERABLE), { force: true });
  } catch {
    // ignore
  }
}

function hasUnrecoverableMarker(dataDir: string): boolean {
  return fs.existsSync(integrityMarkerPath(dataDir, SQLITE_INTEGRITY.MARKER_UNRECOVERABLE));
}

/**
 * 不可恢复标记：第一行稳定 code,第二行隔离后的坏库路径。
 * code 随标记落盘,重启后抛出的 DatabaseIntegrityError 与失败现场同 code
 * (无备份 = DB_CORRUPT_NO_BACKUP;复制/打开恢复副本失败 = DB_RESTORE_FAILED)。
 */
export function writeUnrecoverableMarker(
  dataDir: string,
  isolatedPath: string,
  code: string = SQLITE_INTEGRITY.CORRUPT_NO_BACKUP,
): void {
  try {
    fs.writeFileSync(
      integrityMarkerPath(dataDir, SQLITE_INTEGRITY.MARKER_UNRECOVERABLE),
      `${code}\n${isolatedPath}`,
      'utf8',
    );
  } catch {
    // ignore
  }
}

export function readUnrecoverableMarker(
  dataDir: string,
): { code: string; isolatedPath: string } | null {
  try {
    const raw = fs.readFileSync(
      integrityMarkerPath(dataDir, SQLITE_INTEGRITY.MARKER_UNRECOVERABLE),
      'utf8',
    );
    const [code, isolatedPath] = raw.split('\n');
    if (!code) return null;
    return { code, isolatedPath: isolatedPath ?? '' };
  } catch {
    return null;
  }
}

export function describeIntegrityCheckStatus(dataDir: string): string {
  if (hasUnrecoverableMarker(dataDir)) return 'unrecoverable';
  if (hasIntegrityFailedMarker(dataDir)) {
    const failedAt = readTimestampMarker(
      integrityMarkerPath(dataDir, SQLITE_INTEGRITY.MARKER_INTEGRITY_FAILED),
    );
    return failedAt ? `failed@${new Date(failedAt).toISOString()}` : 'failed';
  }
  const last = readTimestampMarker(
    integrityMarkerPath(dataDir, SQLITE_INTEGRITY.MARKER_INTEGRITY),
  );
  return last ? `ok@${new Date(last).toISOString()}` : 'never';
}

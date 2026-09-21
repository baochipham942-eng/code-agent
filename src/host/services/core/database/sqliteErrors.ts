/**
 * SQLite 损坏判定。better-sqlite3 抛 SqliteError，code/message 带
 * SQLITE_CORRUPT（含 SQLITE_CORRUPT_VTAB）或 "malformed"。
 * JSON 的 "malformed JSON" 不是库损坏，排除。
 *
 * 隔离决策只认真损坏:SQLITE_CORRUPT / SQLITE_NOTADB / malformed。
 * SQLITE_IOERR 绝大多数子码是临时错误(SHMMAP/LOCK/FSYNC…),进隔离编排
 * 会把还能读的库改名,无备份时永久内存模式——临时 IOERR 永远到不了那步。
 */

import { SQLITE_INTEGRITY } from '../../../../shared/constants';

function readStringProp(err: object, key: string): string {
  if (!(key in err)) return '';
  const value = (err as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

export function readSqliteErrorCode(err: unknown): string {
  if (err == null || typeof err !== 'object') return '';
  return readStringProp(err, 'code');
}

export function isSqliteCorruptionError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const code = readStringProp(err, 'code');
  const message = err instanceof Error ? err.message : readStringProp(err, 'message');
  const haystack = `${code}\n${message}`;
  if (/SQLITE_CORRUPT/i.test(haystack)) return true;
  if (/malformed JSON/i.test(haystack)) return false;
  if (/database disk image is malformed/i.test(haystack)) return true;
  if (/malformed database/i.test(haystack)) return true;
  if (/\bmalformed\b/i.test(haystack)) return true;
  return false;
}

/**
 * SQLITE_BUSY（含 WAL 快照冲突 SQLITE_BUSY_SNAPSHOT，better-sqlite3 统一抛
 * "database is locked"）。busy_timeout 到期与快照升级失败都归这类，可重试。
 */
export function isSqliteBusyError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const code = readStringProp(err, 'code');
  if (/SQLITE_BUSY/i.test(code)) return true;
  const message = err instanceof Error ? err.message : readStringProp(err, 'message');
  return /database is locked/i.test(message);
}

/**
 * 已知临时 IOERR 子码(WAL 共享内存映射/锁/刷盘/读写瞬时失败等)。
 * 枚举内走可重试路径;枚举外的 IOERR 子码也无法归类,同样不许隔离。
 */
const TRANSIENT_IOERR_SUBCODES = [
  'SQLITE_IOERR_SHMMAP',
  'SQLITE_IOERR_SHMOPEN',
  'SQLITE_IOERR_SHMLOCK',
  'SQLITE_IOERR_LOCK',
  'SQLITE_IOERR_FSYNC',
  'SQLITE_IOERR_DIR_FSYNC',
  'SQLITE_IOERR_ACCESS',
  'SQLITE_IOERR_READ',
  'SQLITE_IOERR_WRITE',
  'SQLITE_IOERR_SEEK',
  'SQLITE_IOERR_SHORT_READ',
  'SQLITE_IOERR_DELETE',
  'SQLITE_IOERR_TRUNCATE',
  'SQLITE_IOERR_CLOSE',
  'SQLITE_IOERR_MMAP',
  'SQLITE_IOERR_NOMEM',
] as const;

export type SqliteIntegrityClassification = 'corrupt' | 'transient-io' | 'other-io' | 'none';

/**
 * 完整性信号分类:
 * - corrupt       真损坏(CORRUPT/NOTADB/malformed)——唯一允许进隔离/恢复编排的类别;
 * - transient-io  已知临时 IOERR 子码——可重试(重开原库),不隔离、不写标记;
 * - other-io      无法归类的 IOERR——保守方向是不动原库,同样不隔离;
 * - none          与完整性无关(BUSY/CANTOPEN/…)。
 */
export function classifySqliteIntegrityError(err: unknown): SqliteIntegrityClassification {
  if (err == null || typeof err !== 'object') return 'none';
  const code = readStringProp(err, 'code');
  const message = err instanceof Error ? err.message : readStringProp(err, 'message');
  const haystack = `${code}\n${message}`;
  if (isSqliteCorruptionError(err) || /SQLITE_NOTADB/i.test(haystack)) return 'corrupt';
  if (!/SQLITE_IOERR/i.test(haystack)) return 'none';
  return (TRANSIENT_IOERR_SUBCODES as readonly string[]).some((subcode) => haystack.includes(subcode))
    ? 'transient-io'
    : 'other-io';
}

/** 稳定 code 错误：reason 走 code，不把裸 error.message 送上健康面。 */
export class DatabaseIntegrityError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'DatabaseIntegrityError';
    this.code = code;
  }
}

/**
 * 只读降级写路径统一错误。code 稳定，host 不加裸中文；renderer i18n 翻译。
 * SQLITE_READONLY 也归到这个 code，避免把 better-sqlite3 原文送上用户面。
 */
export class DatabaseReadOnlyError extends Error {
  readonly code = SQLITE_INTEGRITY.READONLY;

  constructor() {
    super('Database is read-only (degraded); refusing to write');
    this.name = 'DatabaseReadOnlyError';
  }
}

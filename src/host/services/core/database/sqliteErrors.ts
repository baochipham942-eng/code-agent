/**
 * SQLite 损坏判定。better-sqlite3 抛 SqliteError，code/message 带
 * SQLITE_CORRUPT（含 SQLITE_CORRUPT_VTAB）或 "malformed"。
 * JSON 的 "malformed JSON" 不是库损坏，排除。
 *
 * 隔离决策只认 SQLITE_CORRUPT / SQLITE_IOERR 明确信号；拿不准不隔离。
 */

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

function isSqliteIoError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const code = readStringProp(err, 'code');
  const message = err instanceof Error ? err.message : readStringProp(err, 'message');
  return /SQLITE_IOERR/i.test(`${code}\n${message}`);
}

/** 探针/隔离只认这两种明确信号。SQLITE_BUSY / CANTOPEN / NOTADB 不在此列。 */
export function isSqliteIntegritySignal(err: unknown): boolean {
  return isSqliteCorruptionError(err) || isSqliteIoError(err);
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

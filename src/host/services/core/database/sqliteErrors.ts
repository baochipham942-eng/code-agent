/**
 * SQLite 损坏判定。better-sqlite3 抛 SqliteError，code/message 带
 * SQLITE_CORRUPT（含 SQLITE_CORRUPT_VTAB）或 "malformed"。
 * JSON 的 "malformed JSON" 不是库损坏，排除。
 */

function readStringProp(err: object, key: string): string {
  if (!(key in err)) return '';
  const value = (err as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
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

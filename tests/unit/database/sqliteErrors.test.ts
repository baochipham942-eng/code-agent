import { describe, expect, it } from 'vitest';
import { isSqliteCorruptionError } from '../../../src/host/services/core/database/sqliteErrors';

function sqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'SqliteError', code });
}

describe('isSqliteCorruptionError', () => {
  it('accepts better-sqlite3 SQLITE_CORRUPT', () => {
    expect(isSqliteCorruptionError(sqliteError('SQLITE_CORRUPT', 'database disk image is malformed'))).toBe(true);
  });

  it('accepts SQLITE_CORRUPT_VTAB even without malformed in the message', () => {
    expect(isSqliteCorruptionError(sqliteError(
      'SQLITE_CORRUPT_VTAB',
      'fts5: corruption found reading blob 1 from table "session_messages_fts"',
    ))).toBe(true);
  });

  it('accepts a plain Error whose message is the SQLite malformed-disk text', () => {
    expect(isSqliteCorruptionError(new Error('database disk image is malformed'))).toBe(true);
  });

  it('rejects ordinary errors', () => {
    expect(isSqliteCorruptionError(new Error('boom'))).toBe(false);
    expect(isSqliteCorruptionError(null)).toBe(false);
    expect(isSqliteCorruptionError('SQLITE_CORRUPT')).toBe(false);
  });

  it('rejects FTS syntax errors', () => {
    expect(isSqliteCorruptionError(sqliteError('SQLITE_ERROR', 'fts5: syntax error near "AND"'))).toBe(false);
  });

  it('rejects malformed JSON (not database corruption)', () => {
    expect(isSqliteCorruptionError(sqliteError('SQLITE_ERROR', 'malformed JSON'))).toBe(false);
    expect(isSqliteCorruptionError(new Error('malformed JSON at offset 3'))).toBe(false);
  });
});

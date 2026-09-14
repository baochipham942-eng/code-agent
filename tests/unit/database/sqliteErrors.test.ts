import { describe, expect, it } from 'vitest';
import {
  classifySqliteIntegrityError,
  DatabaseIntegrityError,
  isSqliteCorruptionError,
} from '../../../src/host/services/core/database/sqliteErrors';

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

describe('classifySqliteIntegrityError', () => {
  it('classifies CORRUPT / NOTADB / malformed as corrupt (catastrophic path)', () => {
    expect(classifySqliteIntegrityError(sqliteError('SQLITE_CORRUPT', 'database disk image is malformed'))).toBe('corrupt');
    expect(classifySqliteIntegrityError(sqliteError('SQLITE_NOTADB', 'file is not a database'))).toBe('corrupt');
    expect(classifySqliteIntegrityError(sqliteError('SQLITE_CORRUPT_VTAB', 'malformed'))).toBe('corrupt');
  });

  // 已知临时 IOERR 子码逐个子码钉死:可重试,永远到不了隔离/写标记那步
  it('classifies known transient IOERR subcodes as transient-io', () => {
    for (const subcode of [
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
    ] as const) {
      expect(classifySqliteIntegrityError(sqliteError(subcode, 'disk I/O error')), subcode).toBe('transient-io');
    }
  });

  it('classifies unlisted IOERR subcodes conservatively as other-io (never corrupt)', () => {
    expect(classifySqliteIntegrityError(sqliteError('SQLITE_IOERR_FUTURE_SUBCODE', 'disk I/O error'))).toBe('other-io');
    expect(classifySqliteIntegrityError(sqliteError('SQLITE_IOERR', 'disk I/O error'))).toBe('other-io');
  });

  it('BUSY / CANTOPEN are not integrity signals', () => {
    expect(classifySqliteIntegrityError(sqliteError('SQLITE_BUSY', 'database is locked'))).toBe('none');
    expect(classifySqliteIntegrityError(sqliteError('SQLITE_CANTOPEN', 'unable to open database file'))).toBe('none');
  });

  it('DatabaseIntegrityError exposes the stable code', () => {
    const err = new DatabaseIntegrityError('DB_CORRUPT_NO_BACKUP');
    expect(err.code).toBe('DB_CORRUPT_NO_BACKUP');
    expect(err.message).toBe('DB_CORRUPT_NO_BACKUP');
  });
});

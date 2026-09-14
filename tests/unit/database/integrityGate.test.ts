import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import {
  probeDatabaseIntegrity,
  readUnrecoverableMarker,
  shouldAttemptRestore,
  writeUnrecoverableMarker,
} from '../../../src/host/services/core/database/integrityGate';
import { SQLITE_INTEGRITY } from '../../../src/shared/constants';
// 夹具走生产 applySchema（messagesSchemaFixtureGate 要求），不再手抄 messages DDL。
import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';

function sqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'SqliteError', code });
}

function fakeDb(options: {
  master?: () => unknown;
  tables?: string[];
  select?: Record<string, () => unknown>;
}): BetterSqlite3.Database {
  return {
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes('FROM sqlite_master') && sql.includes('LIMIT 1')) {
          return options.master ? options.master() : { name: 'sessions', type: 'table' };
        }
        for (const [table, fn] of Object.entries(options.select ?? {})) {
          if (sql.includes(`FROM "${table}"`)) return fn();
        }
        return undefined;
      },
      all: () => {
        if (sql.includes('FROM sqlite_master') && sql.includes("type = 'table'")) {
          return (options.tables ?? [...probeDatabaseIntegrity.CRITICAL_TABLES]).map((name) => ({ name }));
        }
        return [];
      },
    }),
  } as unknown as BetterSqlite3.Database;
}

describe('probeDatabaseIntegrity', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the damaged table name when messages SELECT hits SQLITE_CORRUPT', () => {
    const probe = probeDatabaseIntegrity(fakeDb({
      select: {
        messages: () => {
          throw sqliteError('SQLITE_CORRUPT', 'database disk image is malformed');
        },
      },
    }));
    expect(probe.severity).toBe('local');
    expect(probe.sqliteMasterOk).toBe(true);
    const messages = probe.tables.find((row) => row.table === 'messages');
    expect(messages).toMatchObject({ ok: false, errorCode: 'SQLITE_CORRUPT' });
    expect(probe.tables.filter((row) => row.table !== 'messages').every((row) => row.ok)).toBe(true);
  });

  it('treats sqlite_master CORRUPT as catastrophic', () => {
    const probe = probeDatabaseIntegrity(fakeDb({
      master: () => {
        throw sqliteError('SQLITE_CORRUPT', 'database disk image is malformed');
      },
    }));
    expect(probe.severity).toBe('catastrophic');
    expect(probe.sqliteMasterOk).toBe(false);
  });

  it('does not isolate SQLITE_BUSY (uncertain signal)', () => {
    const probe = probeDatabaseIntegrity(fakeDb({
      select: {
        messages: () => {
          throw sqliteError('SQLITE_BUSY', 'database is locked');
        },
      },
    }));
    expect(probe.severity).toBe('ok');
    expect(probe.tables.find((row) => row.table === 'messages')?.ok).toBe(true);
  });

  it('skips tables that do not exist yet (fresh db before applySchema)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-integrity-fresh-'));
    dirs.push(dir);
    const db = new Database(path.join(dir, 'code-agent.db'));
    try {
      const probe = probeDatabaseIntegrity(db);
      expect(probe.severity).toBe('ok');
      expect(probe.tables).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('has zero false positives on a healthy schema and stays under the probe budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-integrity-good-'));
    dirs.push(dir);
    const db = new Database(path.join(dir, 'code-agent.db'));
    try {
      applyTestSessionSchema(db);
      db.prepare(
        `INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('s1', 'ok', 'fixture-provider', 'fixture-model', 1, 1);
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('m1', 's1', 'user', 'hello', 1);
      const probe = probeDatabaseIntegrity(db);
      expect(probe.severity).toBe('ok');
      expect(probe.tables.every((row) => row.ok)).toBe(true);
      expect(probe.elapsedMs).toBeLessThan(SQLITE_INTEGRITY.TIER1_PROBE_BUDGET_MS);
    } finally {
      db.close();
    }
  });
});

describe('shouldAttemptRestore', () => {
  it('restores catastrophic always; .integrity-failed escalates local AND Tier-1-pass to restore', () => {
    expect(shouldAttemptRestore(
      { severity: 'catastrophic', sqliteMasterOk: false, tables: [], elapsedMs: 1 },
      { escalate: false },
    )).toBe(true);
    expect(shouldAttemptRestore(
      { severity: 'local', sqliteMasterOk: true, tables: [], elapsedMs: 1 },
      { escalate: false },
    )).toBe(false);
    expect(shouldAttemptRestore(
      { severity: 'local', sqliteMasterOk: true, tables: [], elapsedMs: 1 },
      { escalate: true },
    )).toBe(true);
    // 方案档 §2.1:quick_check 失败后下次启动升级为尝试恢复——Tier 2 全扫判决优先于 Tier 1 浅探针
    expect(shouldAttemptRestore(
      { severity: 'ok', sqliteMasterOk: true, tables: [], elapsedMs: 1 },
      { escalate: true },
    )).toBe(true);
    expect(shouldAttemptRestore(
      { severity: 'ok', sqliteMasterOk: true, tables: [], elapsedMs: 1 },
      { escalate: false },
    )).toBe(false);
  });
});

describe('unrecoverable marker', () => {
  it('round-trips the stable code with the isolated path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-unrecoverable-'));
    try {
      expect(readUnrecoverableMarker(dir)).toBeNull();
      writeUnrecoverableMarker(dir, '/data/code-agent.db.corrupt-1', SQLITE_INTEGRITY.RESTORE_FAILED);
      expect(readUnrecoverableMarker(dir)).toEqual({
        code: SQLITE_INTEGRITY.RESTORE_FAILED,
        isolatedPath: '/data/code-agent.db.corrupt-1',
      });
      writeUnrecoverableMarker(dir, '/data/code-agent.db.corrupt-2');
      expect(readUnrecoverableMarker(dir)).toEqual({
        code: SQLITE_INTEGRITY.CORRUPT_NO_BACKUP,
        isolatedPath: '/data/code-agent.db.corrupt-2',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

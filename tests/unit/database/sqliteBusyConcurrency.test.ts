// ============================================================================
// SQLITE_BUSY 修复回归（issue #1992）
//   - isSqliteBusyError / runWithSqliteBusyRetry 分类与重试语义
//   - 写锁被占时 addMessage 重试耗尽后抛出、锁释放后落库（同进程双连接）
//   - 8 个子进程并发写同一 WAL 库不出现 database is locked（夜跑事故复现口径）
// ============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import {
  isSqliteBusyError,
} from '../../../src/host/services/core/database/sqliteErrors';
import { runWithSqliteBusyRetry } from '../../../src/host/services/core/database/sqliteBusyRetry';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { SQLITE_BUSY } from '../../../src/shared/constants';
import type { Message } from '../../../src/shared/contract';

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-busy-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      working_directory TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER,
      status TEXT DEFAULT 'idle',
      workspace TEXT,
      last_token_usage TEXT,
      git_branch TEXT
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      responses_output TEXT,
      attachments TEXT,
      thinking TEXT,
      effort_level TEXT,
      synced_at INTEGER,
      content_parts TEXT,
      metadata TEXT,
      is_meta INTEGER NOT NULL DEFAULT 0,
      compaction TEXT,
      visibility TEXT NOT NULL DEFAULT 'active',
      hidden_by_rewind_id TEXT,
      hidden_at INTEGER
    );
  `);
}

function makeMessage(id: string): Message {
  return {
    id,
    role: 'user',
    content: `message ${id}`,
    timestamp: 1_700_000_000_000,
  } as Message;
}

describe('isSqliteBusyError', () => {
  it('认 SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT code 与 database is locked 文案', () => {
    expect(isSqliteBusyError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }))).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY_SNAPSHOT' }))).toBe(true);
    expect(isSqliteBusyError(new Error('database is locked'))).toBe(true);
  });

  it('不把损坏 / 约束 / 普通错误当 busy', () => {
    expect(isSqliteBusyError(Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }))).toBe(false);
    expect(isSqliteBusyError(Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }))).toBe(false);
    expect(isSqliteBusyError(new Error('boom'))).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
    expect(isSqliteBusyError('database is locked')).toBe(false);
  });
});

describe('runWithSqliteBusyRetry', () => {
  const busyError = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });

  it('首次成功不重试', () => {
    const fn = vi.fn(() => 42);
    expect(runWithSqliteBusyRetry(fn)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('busy 后自动重试直到成功', () => {
    let calls = 0;
    const result = runWithSqliteBusyRetry(() => {
      calls += 1;
      if (calls <= SQLITE_BUSY.WRITE_RETRY_LIMIT) throw busyError();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1 + SQLITE_BUSY.WRITE_RETRY_LIMIT);
  });

  it('重试耗尽仍 busy 则抛出，总次数 = 1 + WRITE_RETRY_LIMIT', () => {
    const fn = vi.fn(() => { throw busyError(); });
    expect(() => runWithSqliteBusyRetry(fn)).toThrow(/database is locked/i);
    expect(fn).toHaveBeenCalledTimes(1 + SQLITE_BUSY.WRITE_RETRY_LIMIT);
  });

  it('非 busy 错误不重试，原样抛出', () => {
    const fn = vi.fn(() => { throw new Error('UNIQUE constraint failed'); });
    expect(() => runWithSqliteBusyRetry(fn)).toThrow(/UNIQUE constraint/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('SessionRepository 写锁并发', () => {
  it('写锁被占时 addMessage 重试耗尽抛出 database is locked，锁释放后落库成功', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'busy.db');
    const holder = new Database(dbPath, { timeout: 50 });
    holder.pragma('journal_mode = WAL');
    createSchema(holder);
    holder.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
      VALUES ('s1', 't', 'p', 'm', 1, 1)
    `).run();

    const writer = new Database(dbPath, { timeout: 50 });
    writer.pragma('journal_mode = WAL');
    const repo = new SessionRepository(writer);
    try {
      holder.exec('BEGIN IMMEDIATE');
      expect(() => repo.addMessage('s1', makeMessage('m-blocked'))).toThrow(/database is locked/i);
      holder.exec('COMMIT');

      repo.addMessage('s1', makeMessage('m-after'));
      expect(writer.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).toEqual({ c: 1 });
    } finally {
      if (holder.inTransaction) holder.exec('ROLLBACK');
      writer.close();
      holder.close();
    }
  });

  it('多连接多 Promise 同时写同一 WAL 库全部落库', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'busy.db');
    const init = new Database(dbPath);
    init.pragma('journal_mode = WAL');
    createSchema(init);
    init.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, created_at, updated_at)
      VALUES ('s1', 't', 'p', 'm', 1, 1)
    `).run();
    init.close();

    const CONNECTIONS = 6;
    const ROWS_PER_CONNECTION = 20;
    await Promise.all(
      Array.from({ length: CONNECTIONS }, async (_, connectionIndex) => {
        const db = new Database(dbPath, { timeout: SQLITE_BUSY.BUSY_TIMEOUT_MS });
        db.pragma('journal_mode = WAL');
        const repo = new SessionRepository(db);
        try {
          for (let i = 0; i < ROWS_PER_CONNECTION; i += 1) {
            repo.addMessage('s1', makeMessage(`c${connectionIndex}-m${i}`));
          }
        } finally {
          db.close();
        }
      }),
    );

    const check = new Database(dbPath, { readonly: true });
    try {
      const row = check.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
      expect(row.c).toBe(CONNECTIONS * ROWS_PER_CONNECTION);
    } finally {
      check.close();
    }
  });
});

describe('跨进程并发写（夜跑事故口径：8 个 CLI 会话同库）', () => {
  // node -e 的 argv：[execPath, ...args]
  const WORKER_SCRIPT = `
    const Database = require('better-sqlite3');
    const [dbPath, timeoutMs, rows, worker] = process.argv.slice(1);
    const db = new Database(dbPath, { timeout: Number(timeoutMs) });
    db.pragma('journal_mode = WAL');
    const stmt = db.prepare('INSERT INTO busy_stress (worker, seq) VALUES (?, ?)');
    for (let i = 0; i < Number(rows); i += 1) stmt.run(worker, i);
    db.close();
  `;

  it('8 个子进程并发写不出现 database is locked，行数全齐', async () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'busy.db');
    const init = new Database(dbPath);
    init.pragma('journal_mode = WAL');
    init.exec('CREATE TABLE busy_stress (worker TEXT NOT NULL, seq INTEGER NOT NULL)');
    init.close();

    const WORKERS = 8;
    const ROWS_PER_WORKER = 40;
    const results = await Promise.allSettled(
      Array.from({ length: WORKERS }, (_, workerIndex) =>
        execFileAsync(
          process.execPath,
          ['-e', WORKER_SCRIPT, dbPath, String(SQLITE_BUSY.BUSY_TIMEOUT_MS), String(ROWS_PER_WORKER), `w${workerIndex}`],
          { cwd: process.cwd(), timeout: 60_000 },
        ),
      ),
    );

    const failures = results.filter((r) => r.status === 'rejected');
    const stderrAll = results
      .map((r) => (r.status === 'fulfilled' ? r.value.stderr : String((r as PromiseRejectedResult).reason)))
      .join('\n');
    expect(failures).toEqual([]);
    expect(stderrAll).not.toMatch(/database is locked/i);

    const check = new Database(dbPath, { readonly: true });
    try {
      const row = check.prepare('SELECT COUNT(*) AS c FROM busy_stress').get() as { c: number };
      expect(row.c).toBe(WORKERS * ROWS_PER_WORKER);
    } finally {
      check.close();
    }
  }, 90_000);
});

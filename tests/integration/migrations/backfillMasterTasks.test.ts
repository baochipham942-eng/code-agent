// ============================================================================
// backfillMasterTasks integration test (P3-c2)
// ============================================================================
// 用 file-based SQLite 跑真实迁移逻辑（inline schema + 插测试 sessions +
// 跑 backfillMasterTasks + assert）。
// 不依赖 src/main/services/core/database/schema.ts，避开 electron alias 链。
// ============================================================================

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type BetterSqlite3 from 'better-sqlite3';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database: any = require('better-sqlite3');
import { backfillMasterTasks } from '../../../scripts/migrations/backfill-master-tasks';

function createBackfillSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      model_provider TEXT NOT NULL DEFAULT 'test',
      model_name TEXT NOT NULL DEFAULT 'test-model',
      working_directory TEXT,
      session_type TEXT NOT NULL DEFAULT 'chat',
      read_only INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      master_task_id TEXT
    );

    CREATE TABLE master_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace_uri TEXT NOT NULL,
      plan_progress TEXT NOT NULL DEFAULT '',
      sandbox_id TEXT,
      parent_task_id TEXT,
      owner_user_id TEXT NOT NULL DEFAULT 'local',
      blocks_json TEXT NOT NULL DEFAULT '[]',
      blocked_by_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
  `);
}

describe('backfillMasterTasks', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'backfill-master-tasks-'));
    dbPath = join(tmpDir, 'code-agent.db');
    db = new Database(dbPath);
    createBackfillSchema(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function insertSession(opts: {
    id: string;
    title: string | null;
    workingDirectory: string | null;
    masterTaskId?: string | null;
    isDeleted?: number;
    createdAt?: number;
  }): void {
    const now = opts.createdAt ?? Date.now();
    db.prepare(
      `INSERT INTO sessions (
        id, title, working_directory, is_deleted, created_at, updated_at, master_task_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.id,
      opts.title,
      opts.workingDirectory,
      opts.isDeleted ?? 0,
      now,
      now,
      opts.masterTaskId ?? null,
    );
  }

  function countMasterTasks(): number {
    const row = db.prepare(`SELECT COUNT(*) as n FROM master_tasks`).get() as { n: number };
    return row.n;
  }

  function getSessionMasterTaskId(sessionId: string): string | null {
    const row = db
      .prepare(`SELECT master_task_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { master_task_id: string | null } | undefined;
    return row?.master_task_id ?? null;
  }

  it('空 DB → 不做任何事', () => {
    const result = backfillMasterTasks(db, { dryRun: false, verbose: false });
    expect(result).toEqual({ totalCandidates: 0, created: 0, skipped: 0 });
    expect(countMasterTasks()).toBe(0);
  });

  it('未绑 sessions → 全部 backfill', () => {
    insertSession({ id: 'sess-1', title: 'First Session', workingDirectory: '/path/a' });
    insertSession({ id: 'sess-2', title: 'Second', workingDirectory: '/path/b' });
    insertSession({ id: 'sess-3', title: null, workingDirectory: null });

    const result = backfillMasterTasks(db, { dryRun: false, verbose: false });

    expect(result.totalCandidates).toBe(3);
    expect(result.created).toBe(3);
    expect(result.skipped).toBe(0);
    expect(countMasterTasks()).toBe(3);
    expect(getSessionMasterTaskId('sess-1')).toMatch(/^mt-backfill-/);
    expect(getSessionMasterTaskId('sess-2')).toMatch(/^mt-backfill-/);
    expect(getSessionMasterTaskId('sess-3')).toMatch(/^mt-backfill-/);
  });

  it('已绑 sessions → 跳过', () => {
    insertSession({
      id: 'sess-already-bound',
      title: 'Already',
      workingDirectory: '/',
      masterTaskId: 'mt-existing-1',
    });
    insertSession({ id: 'sess-unbound', title: 'New', workingDirectory: '/' });

    const result = backfillMasterTasks(db, { dryRun: false, verbose: false });

    expect(result.totalCandidates).toBe(1);
    expect(result.created).toBe(1);
    expect(getSessionMasterTaskId('sess-already-bound')).toBe('mt-existing-1');
    expect(getSessionMasterTaskId('sess-unbound')).toMatch(/^mt-backfill-/);
  });

  it('is_deleted=1 sessions → 跳过', () => {
    insertSession({ id: 'sess-deleted', title: 'Deleted', workingDirectory: '/', isDeleted: 1 });
    insertSession({ id: 'sess-alive', title: 'Alive', workingDirectory: '/' });

    const result = backfillMasterTasks(db, { dryRun: false, verbose: false });

    expect(result.totalCandidates).toBe(1);
    expect(result.created).toBe(1);
    expect(getSessionMasterTaskId('sess-deleted')).toBeNull();
    expect(getSessionMasterTaskId('sess-alive')).toMatch(/^mt-backfill-/);
  });

  it('dry-run → 不写 DB', () => {
    insertSession({ id: 'sess-1', title: 'Test', workingDirectory: '/' });
    insertSession({ id: 'sess-2', title: 'Test 2', workingDirectory: '/' });

    const result = backfillMasterTasks(db, { dryRun: true, verbose: false });

    expect(result.totalCandidates).toBe(2);
    expect(result.created).toBe(2);
    expect(countMasterTasks()).toBe(0);
    expect(getSessionMasterTaskId('sess-1')).toBeNull();
    expect(getSessionMasterTaskId('sess-2')).toBeNull();
  });

  it('幂等：跑两次只 backfill 新增的', () => {
    insertSession({ id: 'sess-1', title: 'A', workingDirectory: '/' });
    const first = backfillMasterTasks(db, { dryRun: false, verbose: false });
    expect(first.created).toBe(1);
    expect(countMasterTasks()).toBe(1);

    insertSession({ id: 'sess-2', title: 'B', workingDirectory: '/' });
    const second = backfillMasterTasks(db, { dryRun: false, verbose: false });
    expect(second.totalCandidates).toBe(1);
    expect(second.created).toBe(1);
    expect(countMasterTasks()).toBe(2);
  });

  it('title 空字符串 / null → fallback `Session <id-prefix>`', () => {
    insertSession({ id: 'sess-abc12345-rest', title: '', workingDirectory: '/' });
    insertSession({ id: 'sess-def67890-rest', title: null, workingDirectory: '/' });

    backfillMasterTasks(db, { dryRun: false, verbose: false });

    const titles = db
      .prepare(`SELECT id, title FROM master_tasks ORDER BY created_at ASC`)
      .all() as Array<{ id: string; title: string }>;

    expect(titles).toHaveLength(2);
    expect(titles[0].title).toBe('Session sess-abc');
    expect(titles[1].title).toBe('Session sess-def');
  });

  it('working_directory null → workspace_uri 为空字符串', () => {
    insertSession({ id: 'sess-1', title: 'T', workingDirectory: null });

    backfillMasterTasks(db, { dryRun: false, verbose: false });

    const row = db
      .prepare(`SELECT workspace_uri FROM master_tasks WHERE id LIKE 'mt-backfill-%'`)
      .get() as { workspace_uri: string };

    expect(row.workspace_uri).toBe('');
  });
});

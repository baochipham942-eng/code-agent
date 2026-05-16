// ============================================================================
// MasterTaskRepository — happy-path 单元测试
// ============================================================================
// 用 in-memory better-sqlite3 跑真实 SQL：建 master_tasks + master_task_plan_events
// 两张表（schema 与 src/main/services/core/database/schema.ts / src/cli/database.ts
// 对齐），然后验证 create/getById/list/listInProgress/updateStatus/
// updatePlanProgress/appendPlanEvent/listPlanEvents/softDelete 的行为契约。
//
// 风格仿 tests/unit/repositories/sessionRepositoryFts.test.ts —
// vi.unmock + in-memory + 直接 db.exec schema。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { MasterTaskRepository } from '../../../../src/main/services/core/repositories/masterTaskRepository';

// ----------------------------------------------------------------------------
// Schema helper — 镜像 production schema 中 master_tasks 两张表的定义
// ----------------------------------------------------------------------------

function createMasterTaskSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_tasks (
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
      is_deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (parent_task_id) REFERENCES master_tasks(id) ON DELETE SET NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_task_plan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      master_task_id TEXT NOT NULL,
      chunk TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (master_task_id) REFERENCES master_tasks(id) ON DELETE CASCADE
    );
  `);
}

const WORKSPACE_A = 'file:///tmp/ws-a';
const WORKSPACE_B = 'file:///tmp/ws-b';

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('MasterTaskRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: MasterTaskRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createMasterTaskSchema(db);
    repo = new MasterTaskRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // --------------------------------------------------------------------------
  // create + getById
  // --------------------------------------------------------------------------

  it('create + getById roundtrips all fields (including JSON columns)', () => {
    const row = repo.create({
      id: 'mt-1',
      title: 'do the thing',
      status: 'created',
      workspaceUri: WORKSPACE_A,
      planProgress: 'step 1...',
      sandboxId: 'sb-abc',
      parentTaskId: null,
      ownerUserId: 'alice',
      blocks: ['mt-2', 'mt-3'],
      blockedBy: ['mt-0'],
      metadata: { source: 'cli', priority: 'high' },
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
    });

    expect(row.id).toBe('mt-1');
    expect(row.title).toBe('do the thing');
    expect(row.status).toBe('created');
    expect(row.workspaceUri).toBe(WORKSPACE_A);
    expect(row.planProgress).toBe('step 1...');
    expect(row.sandboxId).toBe('sb-abc');
    expect(row.parentTaskId).toBeNull();
    expect(row.ownerUserId).toBe('alice');
    expect(row.blocks).toEqual(['mt-2', 'mt-3']);
    expect(row.blockedBy).toEqual(['mt-0']);
    expect(row.metadata).toEqual({ source: 'cli', priority: 'high' });
    expect(row.createdAt).toBe(1_700_000_000_000);
    expect(row.updatedAt).toBe(1_700_000_001_000);
    expect(row.finishedAt).toBeNull();
    expect(row.isDeleted).toBe(false);

    const fetched = repo.getById('mt-1');
    expect(fetched).toEqual(row);
  });

  it('create defaults to Date.now() when createdAt/updatedAt omitted', () => {
    const before = Date.now();
    const row = repo.create({
      id: 'mt-2',
      title: 'auto-ts',
      status: 'pending',
      workspaceUri: WORKSPACE_A,
    });
    const after = Date.now();

    expect(row.createdAt).toBeGreaterThanOrEqual(before);
    expect(row.createdAt).toBeLessThanOrEqual(after);
    expect(row.updatedAt).toBe(row.createdAt);
    // 默认 ownerUserId / 空 JSON 字段
    expect(row.ownerUserId).toBe('local');
    expect(row.blocks).toEqual([]);
    expect(row.blockedBy).toEqual([]);
    expect(row.metadata).toEqual({});
    expect(row.planProgress).toBe('');
    expect(row.sandboxId).toBeNull();
    expect(row.parentTaskId).toBeNull();
  });

  it('create preserves explicit createdAt without overwriting with Date.now()', () => {
    const fixedTs = 1_500_000_000_000; // 远古时间戳，确保 Date.now() 不会撞上
    const row = repo.create({
      id: 'mt-3',
      title: 'fixed-ts',
      status: 'queued',
      workspaceUri: WORKSPACE_A,
      createdAt: fixedTs,
    });

    expect(row.createdAt).toBe(fixedTs);
    expect(row.updatedAt).toBe(fixedTs); // updatedAt 默认 fallback 到 createdAt
  });

  // --------------------------------------------------------------------------
  // list
  // --------------------------------------------------------------------------

  it('list without filter returns all non-deleted rows', () => {
    repo.create({ id: 'mt-a', title: 'a', status: 'created', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-b', title: 'b', status: 'running', workspaceUri: WORKSPACE_B });
    repo.create({ id: 'mt-c', title: 'c', status: 'done', workspaceUri: WORKSPACE_A });

    const rows = repo.list();
    expect(rows.map((r) => r.id).sort()).toEqual(['mt-a', 'mt-b', 'mt-c']);
  });

  it('list filters by workspaceUri', () => {
    repo.create({ id: 'mt-a', title: 'a', status: 'running', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-b', title: 'b', status: 'running', workspaceUri: WORKSPACE_B });

    const rows = repo.list({ workspaceUri: WORKSPACE_A });
    expect(rows.map((r) => r.id)).toEqual(['mt-a']);
  });

  it('list filters by status (single value and array)', () => {
    repo.create({ id: 'mt-a', title: 'a', status: 'running', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-b', title: 'b', status: 'paused', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-c', title: 'c', status: 'done', workspaceUri: WORKSPACE_A });

    const singleRows = repo.list({ status: 'running' });
    expect(singleRows.map((r) => r.id)).toEqual(['mt-a']);

    const arrRows = repo.list({ status: ['running', 'paused'] });
    expect(arrRows.map((r) => r.id).sort()).toEqual(['mt-a', 'mt-b']);
  });

  it('list with inProgress=true excludes terminal statuses', () => {
    repo.create({ id: 'mt-run', title: 'run', status: 'running', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-pause', title: 'pause', status: 'paused', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-done', title: 'done', status: 'done', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-fail', title: 'fail', status: 'failed', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-cancel', title: 'cancel', status: 'cancelled', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-err', title: 'err', status: 'error', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-comp', title: 'comp', status: 'completed', workspaceUri: WORKSPACE_A });

    const rows = repo.list({ inProgress: true });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['mt-pause', 'mt-run']);
  });

  it('list respects limit/offset (paging)', () => {
    // 用递增 updatedAt 保证 ORDER BY updated_at DESC 下顺序可预期
    repo.create({ id: 'mt-1', title: '1', status: 'pending', workspaceUri: WORKSPACE_A, updatedAt: 1_000 });
    repo.create({ id: 'mt-2', title: '2', status: 'pending', workspaceUri: WORKSPACE_A, updatedAt: 2_000 });
    repo.create({ id: 'mt-3', title: '3', status: 'pending', workspaceUri: WORKSPACE_A, updatedAt: 3_000 });
    repo.create({ id: 'mt-4', title: '4', status: 'pending', workspaceUri: WORKSPACE_A, updatedAt: 4_000 });

    const firstPage = repo.list({ limit: 2 });
    expect(firstPage.map((r) => r.id)).toEqual(['mt-4', 'mt-3']);

    const secondPage = repo.list({ limit: 2, offset: 2 });
    expect(secondPage.map((r) => r.id)).toEqual(['mt-2', 'mt-1']);
  });

  // --------------------------------------------------------------------------
  // listInProgress
  // --------------------------------------------------------------------------

  it('listInProgress crosses workspaces but defaults to ownerUserId=local', () => {
    repo.create({ id: 'mt-a', title: 'a', status: 'running', workspaceUri: WORKSPACE_A });
    repo.create({ id: 'mt-b', title: 'b', status: 'paused', workspaceUri: WORKSPACE_B });
    repo.create({ id: 'mt-done', title: 'done', status: 'done', workspaceUri: WORKSPACE_A });
    repo.create({
      id: 'mt-alice',
      title: 'alice',
      status: 'running',
      workspaceUri: WORKSPACE_A,
      ownerUserId: 'alice',
    });

    const rows = repo.listInProgress();
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['mt-a', 'mt-b']);

    const aliceRows = repo.listInProgress('alice');
    expect(aliceRows.map((r) => r.id)).toEqual(['mt-alice']);
  });

  // --------------------------------------------------------------------------
  // updateStatus + updatePlanProgress
  // --------------------------------------------------------------------------

  it('updateStatus writes status + finishedAt and respects updatedAt param', () => {
    repo.create({
      id: 'mt-x',
      title: 'x',
      status: 'running',
      workspaceUri: WORKSPACE_A,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    repo.updateStatus('mt-x', 'completed', { updatedAt: 5_000, finishedAt: 5_000 });
    const updated = repo.getById('mt-x');
    expect(updated?.status).toBe('completed');
    expect(updated?.updatedAt).toBe(5_000);
    expect(updated?.finishedAt).toBe(5_000);

    // 不传 finishedAt 时保留旧值
    repo.updateStatus('mt-x', 'done', { updatedAt: 6_000 });
    const updated2 = repo.getById('mt-x');
    expect(updated2?.status).toBe('done');
    expect(updated2?.updatedAt).toBe(6_000);
    expect(updated2?.finishedAt).toBe(5_000); // 保留
  });

  // --------------------------------------------------------------------------
  // appendPlanEvent + listPlanEvents
  // --------------------------------------------------------------------------

  it('appendPlanEvent + listPlanEvents writes incrementally and orders by createdAt', () => {
    repo.create({ id: 'mt-plan', title: 'plan', status: 'running', workspaceUri: WORKSPACE_A });

    repo.appendPlanEvent('mt-plan', 'chunk-a', 1_000);
    repo.appendPlanEvent('mt-plan', 'chunk-c', 3_000);
    repo.appendPlanEvent('mt-plan', 'chunk-b', 2_000);

    const events = repo.listPlanEvents('mt-plan');
    expect(events.map((e) => e.chunk)).toEqual(['chunk-a', 'chunk-b', 'chunk-c']);
    expect(events.map((e) => e.createdAt)).toEqual([1_000, 2_000, 3_000]);
    expect(events.every((e) => typeof e.id === 'number')).toBe(true);

    // 不传 createdAt 时 fallback 到 Date.now()
    const before = Date.now();
    repo.appendPlanEvent('mt-plan', 'chunk-d');
    const after = Date.now();
    const all = repo.listPlanEvents('mt-plan');
    const last = all[all.length - 1];
    expect(last.chunk).toBe('chunk-d');
    expect(last.createdAt).toBeGreaterThanOrEqual(before);
    expect(last.createdAt).toBeLessThanOrEqual(after);
  });

  // --------------------------------------------------------------------------
  // softDelete
  // --------------------------------------------------------------------------

  it('softDelete hides row from getById/list by default; includeDeleted=true recovers it', () => {
    repo.create({ id: 'mt-del', title: 'del', status: 'running', workspaceUri: WORKSPACE_A });

    expect(repo.getById('mt-del')).not.toBeNull();
    repo.softDelete('mt-del', 9_000);

    expect(repo.getById('mt-del')).toBeNull();
    expect(repo.list().map((r) => r.id)).not.toContain('mt-del');

    const recovered = repo.getById('mt-del', { includeDeleted: true });
    expect(recovered).not.toBeNull();
    expect(recovered?.isDeleted).toBe(true);
    expect(recovered?.updatedAt).toBe(9_000);

    const allIncludingDeleted = repo.list({ includeDeleted: true });
    expect(allIncludingDeleted.map((r) => r.id)).toContain('mt-del');
  });

  // --------------------------------------------------------------------------
  // updatePlanProgress (separate from plan events)
  // --------------------------------------------------------------------------

  it('updatePlanProgress overwrites the accumulated plan_progress column', () => {
    repo.create({
      id: 'mt-pp',
      title: 'pp',
      status: 'running',
      workspaceUri: WORKSPACE_A,
      planProgress: 'initial',
    });
    repo.updatePlanProgress('mt-pp', 'fresh content', 7_777);
    const row = repo.getById('mt-pp');
    expect(row?.planProgress).toBe('fresh content');
    expect(row?.updatedAt).toBe(7_777);
  });
});

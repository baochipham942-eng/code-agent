// ============================================================================
// MasterTaskManager Tests
// ============================================================================
//
// 覆盖：
//   - register / unregister / getById（内存 hit / DB hit / 双 miss） / listInProgress
//   - 12 个 transition 方法的持久化 + emit StatusChanged + 终态额外事件
//   - attachAgentTask：chain onHook、子 agent fire TaskCompleted、master 状态不变
//   - appendPlanProgress：in-memory + plan_events + plan_progress + emit Delta
//   - null-db fallback：写操作 log warn 但不抛
//
// Mock 策略：vi.mock('.../masterTaskRepository') 同模块以替换 getMasterTaskDb
//   返回 in-memory better-sqlite3。仿 tests/unit/services/repositories/masterTaskRepository.test.ts
//   的 schema 建表逻辑。
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

// 受测模块 import 之前先 mock getMasterTaskDb
let activeDb: BetterSqlite3.Database | null = null;
vi.mock('../../../src/main/services/core/repositories/masterTaskRepository', async () => {
  // 拉取真模块（保留 MasterTaskRepository class 不变），只 stub getMasterTaskDb
  const actual = await vi.importActual<
    typeof import('../../../src/main/services/core/repositories/masterTaskRepository')
  >('../../../src/main/services/core/repositories/masterTaskRepository');
  return {
    ...actual,
    getMasterTaskDb: () => activeDb,
  };
});

import {
  MasterTaskManager,
  type MasterTaskManagerEvent,
} from '../../../src/main/agent/masterTaskManager';
import { AgentTask } from '../../../src/main/agent/agentTask';
import {
  MasterTaskRepository,
} from '../../../src/main/services/core/repositories/masterTaskRepository';

// ----------------------------------------------------------------------------
// Schema helper
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

// ----------------------------------------------------------------------------
// Event capture helper
// ----------------------------------------------------------------------------

function captureEvents(manager: MasterTaskManager): MasterTaskManagerEvent[] {
  const events: MasterTaskManagerEvent[] = [];
  manager.on('event', (e: MasterTaskManagerEvent) => events.push(e));
  return events;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('MasterTaskManager', () => {
  let db: BetterSqlite3.Database;
  let manager: MasterTaskManager;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createMasterTaskSchema(db);
    activeDb = db;
    manager = new MasterTaskManager();
  });

  afterEach(() => {
    activeDb = null;
    db.close();
  });

  // --------------------------------------------------------------------------
  // register / unregister / getById
  // --------------------------------------------------------------------------

  it('register creates in-memory task, persists to DB, and emits MasterTaskCreated', () => {
    const events = captureEvents(manager);
    const task = manager.register(
      { title: 'demo', workspaceUri: 'file:///tmp/ws' },
      { id: 'mt-1', now: 1_700_000_000_000 },
    );

    expect(task.id).toBe('mt-1');
    expect(task.status).toBe('created');
    expect(manager.getById('mt-1')).toBe(task); // same instance

    // DB row exists
    const repo = new MasterTaskRepository(db);
    const row = repo.getById('mt-1');
    expect(row).not.toBeNull();
    expect(row?.title).toBe('demo');
    expect(row?.status).toBe('created');
    expect(row?.createdAt).toBe(1_700_000_000_000);

    // Event emitted
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'MasterTaskCreated',
      taskId: 'mt-1',
      status: 'created',
    });
  });

  it('register with persist:false only stores in memory (no DB write)', () => {
    manager.register(
      { title: 'in-mem-only', workspaceUri: 'file:///tmp/ws' },
      { id: 'mt-mem', persist: false },
    );

    expect(manager.getById('mt-mem')).not.toBeNull();
    const repo = new MasterTaskRepository(db);
    expect(repo.getById('mt-mem')).toBeNull();
  });

  it('unregister removes from memory but leaves DB row intact', () => {
    manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-x' });
    manager.unregister('mt-x');

    // 内存清掉了，但 getById 会从 DB 重建
    const repo = new MasterTaskRepository(db);
    expect(repo.getById('mt-x')).not.toBeNull();

    // getById 触发重建
    const revived = manager.getById('mt-x');
    expect(revived).not.toBeNull();
    expect(revived?.id).toBe('mt-x');
    expect(revived?.status).toBe('created');
  });

  it('getById falls back to DB and revives instance on memory miss', () => {
    // 直接写 DB（不走 manager.register），模拟跨进程重启场景
    const repo = new MasterTaskRepository(db);
    repo.create({
      id: 'mt-revive',
      title: 'revived',
      status: 'running',
      workspaceUri: 'file:///tmp/ws',
      planProgress: 'partial-plan',
      ownerUserId: 'local',
    });

    const task = manager.getById('mt-revive');
    expect(task).not.toBeNull();
    expect(task?.id).toBe('mt-revive');
    expect(task?.status).toBe('running');
    expect(task?.planProgress).toBe('partial-plan');

    // 再次 getById 应返回内存的同一实例
    expect(manager.getById('mt-revive')).toBe(task);
  });

  it('getById returns null when both memory and DB miss', () => {
    expect(manager.getById('does-not-exist')).toBeNull();
  });

  it('listInProgress merges memory and DB (dedupes by id)', () => {
    // DB-only：未在内存
    const repo = new MasterTaskRepository(db);
    repo.create({
      id: 'mt-db-running',
      title: 'db-running',
      status: 'running',
      workspaceUri: 'file:///tmp/ws',
      ownerUserId: 'local',
    });
    repo.create({
      id: 'mt-db-done',
      title: 'db-done',
      status: 'done',
      workspaceUri: 'file:///tmp/ws',
      ownerUserId: 'local',
    });

    // 内存：persist:false（不走 DB），non-terminal
    manager.register(
      { title: 'mem-only', workspaceUri: 'file:///tmp/ws' },
      { id: 'mt-mem-running', persist: false },
    );

    // 内存 + DB 都有：先 register（会持久化到 DB），别让 dedupe 出 bug
    manager.register(
      { title: 'both', workspaceUri: 'file:///tmp/ws' },
      { id: 'mt-both' },
    );

    const inProgress = manager.listInProgress('local');
    const ids = inProgress.map((t) => t.id).sort();
    // mt-db-done 是终态被剔除；mt-mem-running / mt-db-running / mt-both 都保留
    expect(ids).toEqual(['mt-both', 'mt-db-running', 'mt-mem-running']);
  });

  // --------------------------------------------------------------------------
  // attachAgentTask
  // --------------------------------------------------------------------------

  it('attachAgentTask wires master.childAgentTaskIds, chains onHook, and emits Attached', () => {
    const events = captureEvents(manager);
    manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-att' });
    events.length = 0; // 清掉 Created 事件

    const agent = new AgentTask('ag-1', {
      agentType: 'planner',
      parentSessionId: 'sess-1',
      spawnTime: Date.now(),
      model: 'kimi',
      toolPool: [],
    });

    manager.attachAgentTask('mt-att', agent);

    const master = manager.getById('mt-att')!;
    expect(master.childAgentTaskIds.has('ag-1')).toBe(true);
    expect(agent.parentMasterTaskId).toBe('mt-att');
    expect(typeof agent.onHook).toBe('function');

    expect(events).toContainEqual({
      type: 'MasterTaskAgentTaskAttached',
      taskId: 'mt-att',
      agentTaskId: 'ag-1',
    });
  });

  it('child AgentTask completion emits MasterTaskAgentTaskCompleted but does not change master.status', () => {
    const events = captureEvents(manager);
    manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-c' });
    const agent = new AgentTask('ag-c', {
      agentType: 'worker',
      parentSessionId: 'sess-1',
      spawnTime: Date.now(),
      model: 'kimi',
      toolPool: [],
    });
    manager.attachAgentTask('mt-c', agent);
    events.length = 0;

    // 驱动 AgentTask 到 stopped（fire TaskCompleted with success:true）
    agent.register();
    agent.start();
    agent.stop();

    // master 状态没变（仍是 'created'）
    const master = manager.getById('mt-c')!;
    expect(master.status).toBe('created');

    expect(events).toContainEqual({
      type: 'MasterTaskAgentTaskCompleted',
      taskId: 'mt-c',
      agentTaskId: 'ag-c',
      success: true,
    });
  });

  it('attachAgentTask preserves existing onHook (chain)', () => {
    manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-chain' });
    const agent = new AgentTask('ag-chain', {
      agentType: 'planner',
      parentSessionId: 'sess-1',
      spawnTime: Date.now(),
      model: 'kimi',
      toolPool: [],
    });

    const previousCalls: Array<{ event: string; taskId: string }> = [];
    agent.onHook = (event, payload) => {
      previousCalls.push({ event, taskId: payload.taskId });
    };

    manager.attachAgentTask('mt-chain', agent);

    // 触发 TaskCreated（register 内部 fire）
    agent.register();

    expect(previousCalls).toEqual([{ event: 'TaskCreated', taskId: 'ag-chain' }]);

    // 触发 TaskCompleted
    agent.start();
    agent.stop();

    expect(previousCalls).toEqual([
      { event: 'TaskCreated', taskId: 'ag-chain' },
      { event: 'TaskCompleted', taskId: 'ag-chain' },
    ]);
  });

  // --------------------------------------------------------------------------
  // State transitions
  // --------------------------------------------------------------------------

  it('advance / start / complete emit StatusChanged + Completed(success=true) and persist updates', () => {
    const events = captureEvents(manager);
    manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-flow' });
    events.length = 0;

    manager.advance('mt-flow');
    manager.start('mt-flow');
    manager.complete('mt-flow');

    const statusChanges = events.filter((e) => e.type === 'MasterTaskStatusChanged');
    expect(statusChanges).toHaveLength(3);
    expect(statusChanges[0]).toMatchObject({ from: 'created', to: 'pending' });
    expect(statusChanges[1]).toMatchObject({ from: 'pending', to: 'running' });
    expect(statusChanges[2]).toMatchObject({ from: 'running', to: 'completed' });

    const completed = events.filter((e) => e.type === 'MasterTaskCompleted');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({
      type: 'MasterTaskCompleted',
      taskId: 'mt-flow',
      success: true,
    });

    // 持久化 — DB row.status == completed, finishedAt 非 null
    const repo = new MasterTaskRepository(db);
    const row = repo.getById('mt-flow');
    expect(row?.status).toBe('completed');
    expect(row?.finishedAt).not.toBeNull();
  });

  it('pause + start (resume) round-trip emits two StatusChanged with no terminal events', () => {
    const events = captureEvents(manager);
    manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-pp' });
    manager.advance('mt-pp');
    manager.start('mt-pp');
    events.length = 0;

    manager.pause('mt-pp');
    manager.start('mt-pp');

    const types = events.map((e) => e.type);
    expect(types).toEqual(['MasterTaskStatusChanged', 'MasterTaskStatusChanged']);
    expect(events[0]).toMatchObject({ from: 'running', to: 'paused' });
    expect(events[1]).toMatchObject({ from: 'paused', to: 'running' });
  });

  it('fail emits MasterTaskFailed with error and sets master.error', () => {
    const events = captureEvents(manager);
    manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-fail' });
    manager.advance('mt-fail');
    manager.start('mt-fail');
    events.length = 0;

    manager.fail('mt-fail', 'oom');

    const master = manager.getById('mt-fail')!;
    expect(master.status).toBe('failed');
    expect(master.error).toBe('oom');

    const failed = events.filter((e) => e.type === 'MasterTaskFailed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({
      type: 'MasterTaskFailed',
      taskId: 'mt-fail',
      error: 'oom',
    });

    // 持久化 finishedAt 非 null
    const repo = new MasterTaskRepository(db);
    expect(repo.getById('mt-fail')?.finishedAt).not.toBeNull();
  });

  it('cancel transitions from any non-terminal status and emits MasterTaskCompleted(success=false)', () => {
    const events = captureEvents(manager);
    manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-cancel' });
    manager.advance('mt-cancel');
    events.length = 0;

    manager.cancel('mt-cancel');

    const completed = events.filter((e) => e.type === 'MasterTaskCompleted');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({
      type: 'MasterTaskCompleted',
      taskId: 'mt-cancel',
      success: false,
    });

    expect(manager.getById('mt-cancel')?.status).toBe('cancelled');
  });

  it('approveReview drives to done and emits Completed(success=true)', () => {
    const events = captureEvents(manager);
    manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-rev' });
    manager.advance('mt-rev');
    manager.start('mt-rev');
    manager.requestReview('mt-rev');
    events.length = 0;

    manager.approveReview('mt-rev');

    expect(manager.getById('mt-rev')?.status).toBe('done');
    const completed = events.filter((e) => e.type === 'MasterTaskCompleted');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ taskId: 'mt-rev', success: true });
  });

  // --------------------------------------------------------------------------
  // Plan progress
  // --------------------------------------------------------------------------

  it('appendPlanProgress updates in-memory, appendPlanEvent + updatePlanProgress in DB, and emits Delta', () => {
    const events = captureEvents(manager);
    manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-plan' });
    events.length = 0;

    manager.appendPlanProgress('mt-plan', 'step 1\n');
    manager.appendPlanProgress('mt-plan', 'step 2\n');

    // in-memory 累加
    const master = manager.getById('mt-plan')!;
    expect(master.planProgress).toBe('step 1\nstep 2\n');

    // DB: plan_progress 列 + plan_events 表
    const repo = new MasterTaskRepository(db);
    expect(repo.getById('mt-plan')?.planProgress).toBe('step 1\nstep 2\n');
    const planEvents = repo.listPlanEvents('mt-plan');
    expect(planEvents).toHaveLength(2);
    expect(planEvents[0].chunk).toBe('step 1\n');
    expect(planEvents[1].chunk).toBe('step 2\n');

    // emit Delta × 2
    const deltas = events.filter((e) => e.type === 'MasterTaskPlanProgressDelta');
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toMatchObject({ taskId: 'mt-plan', chunk: 'step 1\n' });
    expect(deltas[1]).toMatchObject({ taskId: 'mt-plan', chunk: 'step 2\n' });
    expect(typeof (deltas[0] as { appendedAt: number }).appendedAt).toBe('number');
  });

  // --------------------------------------------------------------------------
  // Null-db fallback
  // --------------------------------------------------------------------------

  it('writes log warning but do not throw when getMasterTaskDb returns null', () => {
    activeDb = null; // 模拟 db 不可用

    // register 不抛
    expect(() =>
      manager.register({ title: 't', workspaceUri: 'file:///tmp/ws' }, { id: 'mt-nodb' }),
    ).not.toThrow();

    // 转 transition 不抛
    expect(() => manager.advance('mt-nodb')).not.toThrow();
    expect(() => manager.start('mt-nodb')).not.toThrow();

    // appendPlanProgress 不抛
    expect(() => manager.appendPlanProgress('mt-nodb', 'chunk')).not.toThrow();

    // in-memory 状态正确
    const task = manager.getById('mt-nodb');
    expect(task?.status).toBe('running');
    expect(task?.planProgress).toBe('chunk');
  });
});

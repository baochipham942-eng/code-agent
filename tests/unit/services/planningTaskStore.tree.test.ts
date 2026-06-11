// ============================================================================
// taskStore — 树状 ID + owner 语义 + 事件日志（roadmap 2.6）
// ============================================================================
// - 树状 ID：父任务 "1" 的子任务 "1.1"、"1.2"，孙任务 "1.1.1"；
//   子任务不消耗顶层计数器
// - owner：subagent 所有权；orphan 接管（subagent 结束时未收口任务回主会话）
// - 事件日志：created/started/done/abandoned/renamed/owner_changed/blocked/
//   orphan_adopted 追加到 session_task_events（可审计）
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTaskEvent } from '../../../src/shared/contract/planning';

const dbState = vi.hoisted(() => ({
  db: {
    isReady: true,
    saveSessionTasks: vi.fn(),
    getSessionTasks: vi.fn(),
    appendSessionTaskEvents: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function recordedEvents(): SessionTaskEvent[] {
  return dbState.db.appendSessionTaskEvents.mock.calls.flatMap((call) => call[0] as SessionTaskEvent[]);
}

describe('taskStore — tree ids / owner / events (roadmap 2.6)', () => {
  beforeEach(() => {
    vi.resetModules();
    dbState.db.isReady = true;
    dbState.db.saveSessionTasks.mockReset();
    dbState.db.getSessionTasks.mockReset();
    dbState.db.getSessionTasks.mockReturnValue([]);
    dbState.db.appendSessionTaskEvents.mockReset();
    // 单测互染防护：getSessionTaskEvents 只在个别用例显式挂上
    delete (dbState.db as Record<string, unknown>).getSessionTaskEvents;
  });

  it('creates hierarchical child ids without consuming the top-level counter', async () => {
    const taskStore = await import('../../../src/main/services/planning/taskStore');
    const s = 'tree-session';

    const parent = taskStore.createTask(s, { subject: 'Parent', description: 'p' });
    expect(parent.id).toBe('1');

    const child1 = taskStore.createTask(s, { subject: 'Child A', description: 'c', parentTaskId: parent.id });
    const child2 = taskStore.createTask(s, { subject: 'Child B', description: 'c', parentTaskId: parent.id });
    expect(child1.id).toBe('1.1');
    expect(child2.id).toBe('1.2');
    expect(child1.parentTaskId).toBe('1');

    const grandchild = taskStore.createTask(s, { subject: 'Grandchild', description: 'g', parentTaskId: child1.id });
    expect(grandchild.id).toBe('1.1.1');

    // 子任务不占顶层计数
    const top2 = taskStore.createTask(s, { subject: 'Second top', description: 't' });
    expect(top2.id).toBe('2');
  });

  it('throws on unknown parentTaskId', async () => {
    const taskStore = await import('../../../src/main/services/planning/taskStore');
    expect(() =>
      taskStore.createTask('tree-bad-parent', { subject: 'x', description: 'x', parentTaskId: '99' })
    ).toThrow(/parent/i);
  });

  it('hydrated child ids keep the numbering sequence after reload', async () => {
    const taskStore1 = await import('../../../src/main/services/planning/taskStore');
    const s = 'tree-hydrate';
    const parent = taskStore1.createTask(s, { subject: 'P', description: 'p' });
    taskStore1.createTask(s, { subject: 'C1', description: 'c', parentTaskId: parent.id });
    const saved = dbState.db.saveSessionTasks.mock.calls.at(-1)?.[1];

    vi.resetModules();
    dbState.db.getSessionTasks.mockReturnValue(saved);
    const taskStore2 = await import('../../../src/main/services/planning/taskStore');
    const child2 = taskStore2.createTask(s, { subject: 'C2', description: 'c', parentTaskId: '1' });
    expect(child2.id).toBe('1.2');
  });

  it('records owner on create and emits lifecycle events', async () => {
    const taskStore = await import('../../../src/main/services/planning/taskStore');
    const s = 'event-session';

    const task = taskStore.createTask(s, { subject: 'Owned', description: 'o', owner: 'subagent_1_abc' });
    expect(task.owner).toBe('subagent_1_abc');

    taskStore.updateTask(s, task.id, { status: 'in_progress' });
    taskStore.updateTask(s, task.id, { subject: 'Owned renamed' });
    taskStore.updateTask(s, task.id, { owner: 'subagent_2_def' });
    taskStore.updateTask(s, task.id, { status: 'completed' });

    const kinds = recordedEvents().map((e) => e.kind);
    expect(kinds).toEqual(['created', 'started', 'renamed', 'owner_changed', 'done']);
    const created = recordedEvents()[0];
    expect(created.taskId).toBe(task.id);
    expect(created.sessionId).toBe(s);
    expect(typeof created.at).toBe('number');
  });

  it('emits abandoned for cancellation and blocked for dependency additions', async () => {
    const taskStore = await import('../../../src/main/services/planning/taskStore');
    const s = 'event-session-2';
    const a = taskStore.createTask(s, { subject: 'A', description: 'a' });
    const b = taskStore.createTask(s, { subject: 'B', description: 'b' });

    taskStore.updateTask(s, b.id, { addBlockedBy: [a.id] });
    taskStore.updateTask(s, a.id, { status: 'cancelled' });

    const kinds = recordedEvents().map((e) => e.kind);
    expect(kinds).toContain('blocked');
    expect(kinds).toContain('abandoned');
  });

  it('adoptOrphanTasks releases open tasks owned by a finished subagent', async () => {
    const taskStore = await import('../../../src/main/services/planning/taskStore');
    const s = 'orphan-session';
    const owner = 'subagent_99_zzz';

    const open = taskStore.createTask(s, { subject: 'Open', description: 'o', owner });
    const done = taskStore.createTask(s, { subject: 'Done', description: 'd', owner });
    taskStore.updateTask(s, done.id, { status: 'completed' });
    const other = taskStore.createTask(s, { subject: 'Other', description: 'x', owner: 'subagent_other' });

    const adopted = taskStore.adoptOrphanTasks(s, owner);
    expect(adopted.map((t) => t.id)).toEqual([open.id]);

    expect(taskStore.getTask(s, open.id)?.owner).toBeUndefined();
    expect(taskStore.getTask(s, done.id)?.owner).toBe(owner); // 已收口的不动
    expect(taskStore.getTask(s, other.id)?.owner).toBe('subagent_other');

    const kinds = recordedEvents().map((e) => e.kind);
    expect(kinds).toContain('orphan_adopted');
  });

  it('does not reuse a deleted child id (no event-history inheritance)', async () => {
    const taskStore = await import('../../../src/main/services/planning/taskStore');
    const s = 'tree-no-reuse';
    const parent = taskStore.createTask(s, { subject: 'P', description: 'p' });
    taskStore.createTask(s, { subject: 'C1', description: 'c', parentTaskId: parent.id });
    const c2 = taskStore.createTask(s, { subject: 'C2', description: 'c', parentTaskId: parent.id });
    expect(c2.id).toBe('1.2');

    taskStore.deleteTask(s, c2.id);
    const c3 = taskStore.createTask(s, { subject: 'C3', description: 'c', parentTaskId: parent.id });
    expect(c3.id).toBe('1.3'); // 不复用 1.2，避免继承已删任务的事件历史
  });

  it('child counter survives module reload via parent persistence', async () => {
    const taskStore1 = await import('../../../src/main/services/planning/taskStore');
    const s = 'tree-counter-reload';
    const parent = taskStore1.createTask(s, { subject: 'P', description: 'p' });
    const c1 = taskStore1.createTask(s, { subject: 'C1', description: 'c', parentTaskId: parent.id });
    taskStore1.deleteTask(s, c1.id);
    const saved = dbState.db.saveSessionTasks.mock.calls.at(-1)?.[1];

    vi.resetModules();
    dbState.db.getSessionTasks.mockReturnValue(saved);
    const taskStore2 = await import('../../../src/main/services/planning/taskStore');
    const c2 = taskStore2.createTask(s, { subject: 'C2', description: 'c', parentTaskId: '1' });
    expect(c2.id).toBe('1.2'); // 已删 1.1 不复用
  });

  it('deleting a parent detaches children instead of leaving dangling parentTaskId', async () => {
    const taskStore = await import('../../../src/main/services/planning/taskStore');
    const s = 'tree-detach';
    const parent = taskStore.createTask(s, { subject: 'P', description: 'p' });
    const child = taskStore.createTask(s, { subject: 'C', description: 'c', parentTaskId: parent.id });

    taskStore.deleteTask(s, parent.id);
    const orphan = taskStore.getTask(s, child.id);
    expect(orphan).not.toBeNull();
    expect(orphan!.parentTaskId).toBeUndefined();
    expect(recordedEvents().map((e) => e.kind)).toContain('parent_detached');
  });

  it('top-level ids are not reused after reload when events record deleted tasks', async () => {
    const taskStore1 = await import('../../../src/main/services/planning/taskStore');
    const s = 'top-no-reuse';
    taskStore1.createTask(s, { subject: 'T1', description: 't' });
    const t2 = taskStore1.createTask(s, { subject: 'T2', description: 't' });
    taskStore1.deleteTask(s, t2.id);
    const saved = dbState.db.saveSessionTasks.mock.calls.at(-1)?.[1];
    const events = recordedEvents().filter((e) => e.sessionId === s);

    vi.resetModules();
    dbState.db.getSessionTasks.mockReturnValue(saved);
    dbState.db.getSessionTaskEvents = vi.fn(() => events.map((e) => ({ taskId: e.taskId, at: e.at, kind: e.kind })));
    const taskStore2 = await import('../../../src/main/services/planning/taskStore');
    const t3 = taskStore2.createTask(s, { subject: 'T3', description: 't' });
    expect(t3.id).toBe('3'); // 不复用已删的 2
  });

  it('event persistence failure never blocks task mutation', async () => {
    dbState.db.appendSessionTaskEvents.mockImplementation(() => {
      throw new Error('disk full');
    });
    const taskStore = await import('../../../src/main/services/planning/taskStore');
    const task = taskStore.createTask('event-fail', { subject: 'X', description: 'x' });
    expect(task.id).toBe('1');
  });
});

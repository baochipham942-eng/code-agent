import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodoItem } from '../../../src/shared/contract';

const dbState = vi.hoisted(() => ({
  db: {
    isReady: true,
    saveTodos: vi.fn(),
    getTodos: vi.fn(),
    saveSessionTasks: vi.fn(),
    getSessionTasks: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  advanceTodoStatus,
  clearSessionTodos,
  getSessionTodos,
  parseTodos,
  setSessionTodos,
  syncTodosToSessionTasks,
} from '../../../src/host/agent/todoParser';
import { clearTasks, updateTask } from '../../../src/host/services/planning/taskStore';

describe('todoParser persistence', () => {
  beforeEach(() => {
    dbState.db.isReady = true;
    dbState.db.saveTodos.mockReset();
    dbState.db.getTodos.mockReset();
    dbState.db.getTodos.mockReturnValue([]);
    dbState.db.saveSessionTasks.mockReset();
    dbState.db.getSessionTasks.mockReset();
    dbState.db.getSessionTasks.mockReturnValue([]);
  });

  it('persists todos whenever session todos are set', () => {
    const todos: TodoItem[] = [
      { content: 'persist todo', status: 'in_progress', activeForm: 'persisting todo' },
    ];

    setSessionTodos('todo-session-1', todos);

    expect(dbState.db.saveTodos).toHaveBeenCalledWith('todo-session-1', todos);
  });

  it('hydrates todos from SQLite when memory is empty', () => {
    const persisted: TodoItem[] = [
      { content: 'loaded todo', status: 'pending', activeForm: 'loading todo' },
    ];
    dbState.db.getTodos.mockReturnValue(persisted);

    clearSessionTodos('todo-session-hydrate');
    dbState.db.saveTodos.mockClear();

    expect(getSessionTodos('todo-session-hydrate')).toEqual(persisted);
    expect(dbState.db.getTodos).toHaveBeenCalledWith('todo-session-hydrate');
    expect(dbState.db.saveTodos).not.toHaveBeenCalled();
  });

  it('upserts parsed todos into SessionTask records for the task rail', () => {
    clearTasks('todo-session-sync');
    dbState.db.saveSessionTasks.mockClear();

    const first = syncTodosToSessionTasks('todo-session-sync', [
      { content: 'Read code', status: 'completed', activeForm: 'Reading code' },
      { content: 'Patch UI', status: 'in_progress', activeForm: 'Patching UI' },
    ]);

    expect(first.created).toHaveLength(2);
    expect(first.tasks.map((task) => task.status)).toEqual(['completed', 'in_progress']);
    expect(first.tasks.map((task) => task.subject)).toEqual(['Read code', 'Patch UI']);

    const second = syncTodosToSessionTasks('todo-session-sync', [
      { content: 'Read code', status: 'pending', activeForm: 'Reading code' },
      { content: 'Patch UI', status: 'completed', activeForm: 'Patching UI' },
    ]);

    expect(second.created).toHaveLength(0);
    expect(second.updated).toHaveLength(1);
    expect(second.tasks.map((task) => task.status)).toEqual(['completed', 'completed']);
  });

  it('does not resurrect cancelled SessionTask records from parsed todos', () => {
    clearTasks('todo-session-cancelled');

    const first = syncTodosToSessionTasks('todo-session-cancelled', [
      { content: 'Drop old path', status: 'pending', activeForm: 'Dropping old path' },
    ]);
    expect(first.tasks[0].status).toBe('pending');

    updateTask('todo-session-cancelled', first.tasks[0].id, { status: 'cancelled' });

    const second = syncTodosToSessionTasks('todo-session-cancelled', [
      { content: 'Drop old path', status: 'in_progress', activeForm: 'Dropping old path' },
    ]);

    expect(second.created).toHaveLength(0);
    expect(second.tasks[0].status).toBe('cancelled');
  });

  it('does not promote a second todo while another todo is already in progress', () => {
    const result = advanceTodoStatus([
      { content: 'Read code', status: 'completed', activeForm: 'Reading code' },
      { content: 'Patch UI', status: 'pending', activeForm: 'Patching UI' },
      { content: 'Verify behavior', status: 'in_progress', activeForm: 'Verifying behavior' },
    ]);

    expect(result.updated).toBe(false);
    expect(result.todos.map((todo) => todo.status)).toEqual(['completed', 'pending', 'in_progress']);
  });
});

describe('todoParser extraction guard', () => {
  it('does not promote answer checklists into session todos', () => {
    const parsed = parseTodos([
      '- [ ] 保留合同提醒 7/3/1 天',
      '- [ ] 保留每周五复盘',
      '- [ ] 删除无用页面',
    ].join('\n'));

    expect(parsed).toBeNull();
  });

  it('promotes checkbox lists with explicit task intent', () => {
    const parsed = parseTodos([
      '任务清单：',
      '- [ ] 修复内部判断 fallback',
      '- [ ] 验证 todo 不再污染右侧面板',
    ].join('\n'));

    expect(parsed).toHaveLength(2);
    expect(parsed?.[0].content).toBe('修复内部判断 fallback');
  });

  it('promotes checkbox lists when an explicit plan title is present', () => {
    const parsed = parseTodos([
      '## Plan: Stabilize task panel',
      '- [ ] Load SessionTask records through IPC',
      '- [ ] Render dependency updates',
    ].join('\n'));

    expect(parsed).toHaveLength(2);
    expect(parsed?.[0].content).toBe('Load SessionTask records through IPC');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodoItem } from '../../../src/shared/contract';

const dbState = vi.hoisted(() => ({
  db: {
    isReady: true,
    saveTodos: vi.fn(),
    getTodos: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  clearSessionTodos,
  getSessionTodos,
  setSessionTodos,
} from '../../../src/main/agent/todoParser';

describe('todoParser persistence', () => {
  beforeEach(() => {
    dbState.db.isReady = true;
    dbState.db.saveTodos.mockReset();
    dbState.db.getTodos.mockReset();
    dbState.db.getTodos.mockReturnValue([]);
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
});

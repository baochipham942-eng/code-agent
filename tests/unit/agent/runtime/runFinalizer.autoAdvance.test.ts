import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TodoItem } from '../../../../src/shared/contract';

const dbState = vi.hoisted(() => ({
  db: {
    isReady: true,
    saveTodos: vi.fn(),
    getTodos: vi.fn(),
    saveSessionTasks: vi.fn(),
    getSessionTasks: vi.fn(),
  },
}));

vi.mock('../../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

vi.mock('../../../../src/main/services/infra/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { RunFinalizer } from '../../../../src/main/agent/runtime/runFinalizer';
import {
  clearSessionTodos,
  getSessionTodos,
  setSessionTodos,
} from '../../../../src/main/agent/todoParser';
import { clearTasks } from '../../../../src/main/services/planning/taskStore';

function makeFinalizer(onEvent = vi.fn()): RunFinalizer {
  return new RunFinalizer({
    sessionId: 'sess-auto-advance',
    onEvent,
  } as never);
}

function seedTodos(): TodoItem[] {
  const todos: TodoItem[] = [
    { content: 'Inspect repo', status: 'in_progress', activeForm: 'Inspecting repo' },
    { content: 'Patch code', status: 'pending', activeForm: 'Patching code' },
  ];
  setSessionTodos('sess-auto-advance', todos);
  return todos;
}

describe('RunFinalizer autoAdvanceTodos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.db.getTodos.mockReturnValue([]);
    clearSessionTodos('sess-auto-advance');
    clearTasks('sess-auto-advance');
  });

  it('does not advance todos for an unmarked successful Bash call', () => {
    seedTodos();
    const finalizer = makeFinalizer();

    finalizer.autoAdvanceTodos(
      [{ id: 'tool-1', name: 'Bash', arguments: { command: 'ls src' } }],
      [{ toolCallId: 'tool-1', success: true }],
    );

    expect(getSessionTodos('sess-auto-advance').map((todo) => todo.status)).toEqual([
      'in_progress',
      'pending',
    ]);
  });

  it('advances todos for a Bash call marked as verification', () => {
    seedTodos();
    const finalizer = makeFinalizer();

    finalizer.autoAdvanceTodos(
      [{ id: 'tool-1', name: 'Bash', arguments: { command: 'npm test', purpose: 'verification' } }],
      [{ toolCallId: 'tool-1', success: true }],
    );

    expect(getSessionTodos('sess-auto-advance').map((todo) => todo.status)).toEqual([
      'completed',
      'in_progress',
    ]);
  });

  it('still advances todos for a successful edit call', () => {
    seedTodos();
    const finalizer = makeFinalizer();

    finalizer.autoAdvanceTodos(
      [{ id: 'tool-1', name: 'Edit', arguments: { file_path: '/tmp/a.ts' } }],
      [{ toolCallId: 'tool-1', success: true }],
    );

    expect(getSessionTodos('sess-auto-advance').map((todo) => todo.status)).toEqual([
      'completed',
      'in_progress',
    ]);
  });
});

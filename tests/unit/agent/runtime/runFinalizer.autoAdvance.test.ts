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

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => dbState.db,
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
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

import { RunFinalizer } from '../../../../src/host/agent/runtime/runFinalizer';
import {
  clearSessionTodos,
  getSessionTodos,
  setSessionTodos,
} from '../../../../src/host/agent/todoParser';
import { clearTasks, listTasks } from '../../../../src/host/services/planning/taskStore';

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

  // ADR-050 接线门（X5.5-A2-b）：#826 让 autoAdvance 带上机器证据章，但这条**接线**
  // 此前没有任何测试盯着——亲手把 runFinalizer 里那个 { completionEvidence } 删掉，
  // 三条 todo 断言全绿：todoParser 会静默兜底成「agent 自报」章，taskStore 的
  // fail-loud 门也照样放行。于是「机器推进」和「模型自己勾的」在账本上再也分不开，
  // 而这个区分正是证据章存在的全部理由。断言钉在落账的 source 上，不是钉在 todo 状态上。
  it('自动推进落账带的是机器证据章，不是 agent 自报章', () => {
    seedTodos();
    const finalizer = makeFinalizer();

    finalizer.autoAdvanceTodos(
      [{ id: 'tool-7', name: 'Edit', arguments: { file_path: '/tmp/a.ts' } }],
      [{ toolCallId: 'tool-7', success: true }],
    );

    const completed = listTasks('sess-auto-advance').find((task) => task.status === 'completed');
    expect(completed?.evidenceRefs?.[0]?.source).toBe('todo_parser:auto-advance');
    expect(completed?.evidenceRefs?.[0]?.source).not.toBe('todo_parser:self-report');
    // 证据必须指认得出是哪次工具调用改了什么，否则章盖了等于没盖
    expect(completed?.evidenceRefs?.[0]?.ref).toContain('/tmp/a.ts');
    expect(completed?.evidenceRefs?.[0]?.ref).toContain('tool-7');
  });
});

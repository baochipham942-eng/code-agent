// ============================================================================
// TaskManager (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

const createTaskMock = vi.fn();
const updateTaskMock = vi.fn();
const getTaskMock = vi.fn();
const listTasksMock = vi.fn().mockReturnValue([]);
const clearTasksMock = vi.fn();
const isDesktopDerivedSessionTaskMock = vi.fn().mockReturnValue(false);

vi.mock('../../../../../src/host/services/planning/taskStore', () => ({
  createTask: (...a: unknown[]) => createTaskMock(...a),
  updateTask: (...a: unknown[]) => updateTaskMock(...a),
  getTask: (...a: unknown[]) => getTaskMock(...a),
  listTasks: (...a: unknown[]) => listTasksMock(...a),
  clearTasks: (...a: unknown[]) => clearTasksMock(...a),
  isClosedTaskStatus: (status: string) => status === 'completed' || status === 'cancelled',
}));
vi.mock('../../../../../src/host/desktop/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    recordTodoFeedbackForTask: vi.fn(),
    clearTodoFeedbackForTask: vi.fn(),
  }),
  isDesktopDerivedSessionTask: (...a: unknown[]) => isDesktopDerivedSessionTaskMock(...a),
}));

import { taskManagerModule } from '../../../../../src/host/tools/modules/planning/taskManager';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess-1',
    workingDir: '/tmp',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

beforeEach(() => {
  vi.clearAllMocks();
  listTasksMock.mockReturnValue([]);
});

function makeTask(id: string, status: 'pending' | 'in_progress' | 'completed' | 'cancelled' = 'pending') {
  return {
    id,
    subject: `task ${id}`,
    description: `task ${id} description`,
    activeForm: `doing task ${id}`,
    status,
    priority: 'normal',
    blocks: [],
    blockedBy: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('TaskManager schema', () => {
  it('对齐 legacy schema name/required/enum', () => {
    expect(taskManagerModule.schema.name).toBe('TaskManager');
    expect(taskManagerModule.schema.category).toBe('planning');
    expect(taskManagerModule.schema.permissionLevel).toBe('write');
    expect(taskManagerModule.schema.inputSchema.required).toEqual(['action']);
    const props = taskManagerModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toEqual(['create', 'get', 'list', 'update', 'replace', 'patch']);
    expect(props.status.enum).toEqual(['pending', 'in_progress', 'completed', 'cancelled', 'deleted']);
  });
});

describe('TaskManager dispatch', () => {
  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute({ action: 'list' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute(
      { action: 'list' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('未知 action → INVALID_ARGS', async () => {
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute({ action: 'bogus' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Unknown action');
    }
  });

  it('action=replace replaces the plan and promotes exactly one task to in_progress', async () => {
    let nextId = 0;
    createTaskMock.mockImplementation((_sessionId: string, input: Record<string, unknown>) => {
      nextId += 1;
      return { ...makeTask(String(nextId)), ...input, id: String(nextId), status: 'pending' };
    });
    listTasksMock.mockReturnValue([
      makeTask('1', 'in_progress'),
      makeTask('2', 'pending'),
    ]);

    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute(
      {
        action: 'replace',
        tasks: [
          { subject: 'A' },
          { subject: 'B' },
        ],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(clearTasksMock).toHaveBeenCalledWith('sess-1');
    expect(createTaskMock).toHaveBeenCalledTimes(2);
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
    expect(updateTaskMock).toHaveBeenCalledWith('sess-1', '1', { status: 'in_progress' });
  });

  it('action=patch keeps exactly one in_progress task when a batch moves focus', async () => {
    listTasksMock.mockReturnValue([
      makeTask('1', 'in_progress'),
      makeTask('2', 'pending'),
      makeTask('3', 'pending'),
    ]);

    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute(
      {
        action: 'patch',
        tasks: [
          { taskId: '2', status: 'in_progress' },
          { taskId: '3', status: 'in_progress' },
        ],
      },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(updateTaskMock).toHaveBeenCalledWith('sess-1', '1', { status: 'pending' });
    expect(updateTaskMock).toHaveBeenCalledWith('sess-1', '2', { status: 'in_progress' });
    expect(updateTaskMock).not.toHaveBeenCalledWith('sess-1', '3', { status: 'in_progress' });
  });

  it('action=list dispatch → 调用 list', async () => {
    listTasksMock.mockReturnValue([]);
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute({ action: 'list' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('No tasks');
  });

  it('action=create dispatch → 调用 create', async () => {
    createTaskMock.mockReturnValue({
      id: '1',
      subject: 's',
      status: 'pending',
      priority: 'normal',
      activeForm: 'S',
    });
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute(
      { action: 'create', subject: 's', description: 'd' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('Task #1 created:');
  });

  it('action=get dispatch → 调用 get + NOT_FOUND', async () => {
    getTaskMock.mockReturnValue(undefined);
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute({ action: 'get', taskId: '99' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_FOUND');
  });

  it('action=update dispatch → 调用 update', async () => {
    getTaskMock.mockReturnValue({ id: '1', subject: 's', status: 'pending' });
    updateTaskMock.mockReturnValue({ id: '1', subject: 's', status: 'completed' });
    const handler = await taskManagerModule.createHandler();
    const result = await handler.execute(
      { action: 'update', taskId: '1', status: 'completed' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('Task #1 updated:');
  });
});

// ============================================================================
// TaskUpdate (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

const desktopActivityServiceMock = {
  recordTodoFeedbackForTask: vi.fn(),
  clearTodoFeedbackForTask: vi.fn(),
};
const isDesktopDerivedSessionTaskMock = vi.fn().mockReturnValue(false);
const updateTaskMock = vi.fn();
const getTaskMock = vi.fn();
const listTasksMock = vi.fn().mockReturnValue([]);

vi.mock('../../../../../src/host/desktop/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => desktopActivityServiceMock,
  isDesktopDerivedSessionTask: (...args: unknown[]) => isDesktopDerivedSessionTaskMock(...args),
}));
vi.mock('../../../../../src/host/services/planning/taskStore', () => ({
  updateTask: (...args: unknown[]) => updateTaskMock(...args),
  getTask: (...args: unknown[]) => getTaskMock(...args),
  listTasks: (...args: unknown[]) => listTasksMock(...args),
}));

import { taskUpdateModule } from '../../../../../src/host/tools/modules/planning/taskUpdate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'sess-1',
    workingDir: '/tmp/test',
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
  isDesktopDerivedSessionTaskMock.mockReturnValue(false);
  listTasksMock.mockReturnValue([]);
});

describe('task_update schema', () => {
  it('对齐 legacy schema name/required/enum', () => {
    expect(taskUpdateModule.schema.name).toBe('task_update');
    expect(taskUpdateModule.schema.category).toBe('planning');
    expect(taskUpdateModule.schema.permissionLevel).toBe('write');
    expect(taskUpdateModule.schema.allowInPlanMode).toBe(true);
    expect(taskUpdateModule.schema.inputSchema.required).toEqual(['taskId']);
    const props = taskUpdateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.status.enum).toEqual(['pending', 'in_progress', 'completed', 'cancelled', 'deleted']);
    expect(props.desktopAction.enum).toEqual(['accept', 'dismiss', 'snooze', 'reopen', 'supersede']);
  });
});

describe('task_update behavior', () => {
  it('缺 taskId → INVALID_ARGS', async () => {
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute({ taskId: '1' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute(
      { taskId: '1' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('task 不存在 → NOT_FOUND', async () => {
    getTaskMock.mockReturnValue(undefined);
    listTasksMock.mockReturnValue([{ id: '5' }]);
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute({ taskId: '99' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.error).toContain('Available task IDs: 5');
    }
  });

  it('Invalid desktopAction → INVALID_ARGS', async () => {
    getTaskMock.mockReturnValue({ id: '1' });
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute(
      { taskId: '1', desktopAction: 'bogus' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Invalid desktopAction');
    }
  });

  it('desktopAction on non-desktop task → INVALID_ARGS', async () => {
    getTaskMock.mockReturnValue({ id: '1' });
    isDesktopDerivedSessionTaskMock.mockReturnValue(false);
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute(
      { taskId: '1', desktopAction: 'accept' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('only be used with desktop-derived tasks');
    }
  });

  it('addBlockedBy ID 不存在 → INVALID_ARGS', async () => {
    getTaskMock.mockReturnValue({ id: '1' });
    listTasksMock.mockReturnValue([{ id: '1' }]);
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute(
      { taskId: '1', addBlockedBy: ['99'] },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('Task #99 does not exist');
    }
  });

  it('updateTask 返回 null → DOMAIN_ERROR', async () => {
    getTaskMock.mockReturnValue({ id: '1' });
    updateTaskMock.mockReturnValue(undefined);
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute(
      { taskId: '1', status: 'completed' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DOMAIN_ERROR');
  });

  it('happy update → 输出 1:1 复刻 + emit + meta', async () => {
    getTaskMock.mockReturnValue({ id: '1', subject: 'Old', status: 'pending' });
    updateTaskMock.mockReturnValue({ id: '1', subject: 'New', status: 'in_progress' });
    listTasksMock.mockReturnValue([{ id: '1' }]);
    const emitFn = vi.fn();
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute(
      { taskId: '1', status: 'in_progress', subject: 'New' },
      makeCtx({ emit: emitFn } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Task #1 updated:');
      expect(result.output).toContain('Subject: New');
      expect(result.output).toContain('Status: in_progress');
      expect(result.output).toContain('status → in_progress');
      expect(result.output).toContain('subject updated');
    }
    expect(emitFn).toHaveBeenCalledWith('task_update', expect.objectContaining({
      action: 'update',
      taskId: '1',
    }));
  });

  it('status="deleted" → "deleted successfully" + meta deleted', async () => {
    getTaskMock.mockReturnValue({ id: '1', subject: 'X', status: 'pending' });
    updateTaskMock.mockReturnValue({ id: '1', subject: 'X', status: 'deleted' });
    const emitFn = vi.fn();
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute(
      { taskId: '1', status: 'deleted' },
      makeCtx({ emit: emitFn } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('Task #1 deleted successfully.');
      expect(result.meta).toEqual({ deleted: true, taskId: '1' });
    }
    expect(emitFn).toHaveBeenCalledWith('task_update', expect.objectContaining({
      action: 'delete',
    }));
  });

  it('status="cancelled" → updated task stays visible', async () => {
    getTaskMock.mockReturnValue({ id: '1', subject: 'X', status: 'pending' });
    updateTaskMock.mockReturnValue({ id: '1', subject: 'X', status: 'cancelled' });
    const emitFn = vi.fn();
    const handler = await taskUpdateModule.createHandler();
    const result = await handler.execute(
      { taskId: '1', status: 'cancelled' },
      makeCtx({ emit: emitFn } as unknown as Partial<ToolContext>),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Status: cancelled');
      expect(result.meta).toEqual({ task: { id: '1', subject: 'X', status: 'cancelled' } });
    }
    expect(emitFn).toHaveBeenCalledWith('task_update', expect.objectContaining({
      action: 'update',
      taskId: '1',
    }));
  });

  it('desktopAction=snooze → recordTodoFeedbackForTask 调用 snoozed + reason', async () => {
    const desktopTask = { id: '1', metadata: { desktopTodoKey: 'k1' } };
    getTaskMock.mockReturnValue(desktopTask);
    updateTaskMock.mockReturnValue(desktopTask);
    isDesktopDerivedSessionTaskMock.mockReturnValue(true);
    const handler = await taskUpdateModule.createHandler();
    await handler.execute(
      { taskId: '1', desktopAction: 'snooze', desktopSnoozeHours: 6 },
      makeCtx(),
      allowAll,
    );
    expect(desktopActivityServiceMock.recordTodoFeedbackForTask).toHaveBeenCalledWith(
      desktopTask,
      'snoozed',
      expect.objectContaining({
        sessionId: 'sess-1',
        source: 'task',
        reason: 'task_update:snooze:6h',
      }),
    );
  });

  it('desktop-derived cancelled task records dismissed feedback', async () => {
    const desktopTask = { id: '1', metadata: { desktopTodoKey: 'k1' } };
    getTaskMock.mockReturnValue(desktopTask);
    updateTaskMock.mockReturnValue({ ...desktopTask, status: 'cancelled' });
    isDesktopDerivedSessionTaskMock.mockReturnValue(true);
    const handler = await taskUpdateModule.createHandler();
    await handler.execute(
      { taskId: '1', status: 'cancelled' },
      makeCtx(),
      allowAll,
    );
    expect(desktopActivityServiceMock.recordTodoFeedbackForTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', status: 'cancelled' }),
      'dismissed',
      { sessionId: 'sess-1', source: 'task' },
    );
  });
});

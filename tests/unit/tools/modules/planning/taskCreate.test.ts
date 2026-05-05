// ============================================================================
// TaskCreate (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

const createTaskMock = vi.fn();
const listTasksMock = vi.fn().mockReturnValue([]);

vi.mock('../../../../../src/main/services/planning/taskStore', () => ({
  createTask: (...args: unknown[]) => createTaskMock(...args),
  listTasks: (...args: unknown[]) => listTasksMock(...args),
}));

import { taskCreateModule } from '../../../../../src/main/tools/modules/planning/taskCreate';

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
});

describe('task_create schema', () => {
  it('对齐 legacy schema name/required', () => {
    expect(taskCreateModule.schema.name).toBe('task_create');
    expect(taskCreateModule.schema.category).toBe('planning');
    expect(taskCreateModule.schema.permissionLevel).toBe('write');
    expect(taskCreateModule.schema.allowInPlanMode).toBe(true);
    expect(taskCreateModule.schema.inputSchema.required).toEqual(['subject', 'description']);
    const props = taskCreateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.priority.enum).toEqual(['low', 'normal', 'high']);
  });
});

describe('task_create behavior', () => {
  it('缺 subject → INVALID_ARGS', async () => {
    const handler = await taskCreateModule.createHandler();
    const result = await handler.execute({ description: 'd' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('缺 description → INVALID_ARGS', async () => {
    const handler = await taskCreateModule.createHandler();
    const result = await handler.execute({ subject: 's' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await taskCreateModule.createHandler();
    const result = await handler.execute(
      { subject: 's', description: 'd' },
      makeCtx(),
      denyAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await taskCreateModule.createHandler();
    const result = await handler.execute(
      { subject: 's', description: 'd' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('happy path → 输出 1:1 + emit task_update + meta', async () => {
    createTaskMock.mockReturnValue({
      id: '1',
      subject: 'Implement login',
      status: 'pending',
      priority: 'high',
      activeForm: 'Implementing login',
    });
    listTasksMock.mockReturnValue([{ id: '1' }]);
    const emitFn = vi.fn();
    const handler = await taskCreateModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute(
      {
        subject: 'Implement login',
        description: 'Add OAuth flow',
        priority: 'high',
        metadata: { tag: 'auth' },
      },
      makeCtx({ emit: emitFn } as unknown as Partial<ToolContext>),
      allowAll,
      onProgress,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Task #1 created:');
      expect(result.output).toContain('Subject: Implement login');
      expect(result.output).toContain('Status: pending');
      expect(result.output).toContain('Priority: high');
      expect(result.output).toContain('Active Form: Implementing login');
      expect(result.meta?.taskId).toBe('1');
    }
    expect(createTaskMock).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      subject: 'Implement login',
      description: 'Add OAuth flow',
      priority: 'high',
      metadata: { tag: 'auth' },
    }));
    expect(emitFn).toHaveBeenCalledWith('task_update', expect.objectContaining({
      action: 'create',
      taskId: '1',
    }));
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('priority 缺省 → "normal"', async () => {
    createTaskMock.mockReturnValue({
      id: '1',
      subject: 's',
      status: 'pending',
      priority: 'normal',
      activeForm: 'S',
    });
    const handler = await taskCreateModule.createHandler();
    await handler.execute({ subject: 's', description: 'd' }, makeCtx(), allowAll);
    expect(createTaskMock).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      priority: 'normal',
      metadata: {},
    }));
  });
});

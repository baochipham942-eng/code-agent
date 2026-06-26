// ============================================================================
// TaskGet (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

const getTaskMock = vi.fn();
const listTasksMock = vi.fn().mockReturnValue([]);

vi.mock('../../../../../src/host/services/planning/taskStore', () => ({
  getTask: (...args: unknown[]) => getTaskMock(...args),
  listTasks: (...args: unknown[]) => listTasksMock(...args),
  isClosedTaskStatus: (status: string) => status === 'completed' || status === 'cancelled',
}));

import { taskGetModule } from '../../../../../src/host/tools/modules/planning/taskGet';

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
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

beforeEach(() => {
  vi.clearAllMocks();
  listTasksMock.mockReturnValue([]);
});

describe('task_get schema', () => {
  it('对齐 legacy schema name/required', () => {
    expect(taskGetModule.schema.name).toBe('task_get');
    expect(taskGetModule.schema.category).toBe('planning');
    expect(taskGetModule.schema.permissionLevel).toBe('read');
    expect(taskGetModule.schema.readOnly).toBe(true);
    expect(taskGetModule.schema.inputSchema.required).toEqual(['taskId']);
  });
});

describe('task_get behavior', () => {
  it('缺 taskId → INVALID_ARGS', async () => {
    const handler = await taskGetModule.createHandler();
    const result = await handler.execute({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
  });

  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await taskGetModule.createHandler();
    const result = await handler.execute({ taskId: '1' }, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await taskGetModule.createHandler();
    const result = await handler.execute(
      { taskId: '1' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('task 不存在 → NOT_FOUND with available IDs', async () => {
    getTaskMock.mockReturnValue(undefined);
    listTasksMock.mockReturnValue([{ id: '1' }, { id: '2' }]);
    const handler = await taskGetModule.createHandler();
    const result = await handler.execute({ taskId: '99' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NOT_FOUND');
      expect(result.error).toContain('Task #99 not found');
      expect(result.error).toContain('Available task IDs: 1, 2');
    }
  });

  it('happy path → 输出 1:1 复刻 (含 blockedBy/blocks/metadata)', async () => {
    const task = {
      id: '1',
      subject: 'do it',
      description: 'desc',
      status: 'in_progress',
      priority: 'high',
      activeForm: 'Doing it',
      owner: 'me',
      blockedBy: ['2'],
      blocks: ['3'],
      metadata: { foo: 'bar' },
    };
    getTaskMock.mockReturnValue(task);
    listTasksMock.mockReturnValue([
      task,
      { id: '2', status: 'pending', blockedBy: [] },
      { id: '3', status: 'pending', blockedBy: [] },
    ]);
    const handler = await taskGetModule.createHandler();
    const onProgress = vi.fn();
    const result = await handler.execute({ taskId: '1' }, makeCtx(), allowAll, onProgress);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Task #1:');
      expect(result.output).toContain('Subject: do it');
      expect(result.output).toContain('Status: in_progress');
      expect(result.output).toContain('Priority: high');
      expect(result.output).toContain('Owner: me');
      expect(result.output).toContain('Blocked By: 2 (1 open)');
      expect(result.output).toContain('Blocks: 3');
      expect(result.output).toContain('Metadata: {"foo":"bar"}');
      expect(result.meta?.task).toEqual(task);
    }
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('blockedBy all completed/cancelled → "all resolved"', async () => {
    const task = {
      id: '1',
      subject: 'x',
      description: '',
      status: 'pending',
      priority: 'normal',
      activeForm: 'X',
      blockedBy: ['2'],
      blocks: [],
      metadata: {},
    };
    getTaskMock.mockReturnValue(task);
    listTasksMock.mockReturnValue([
      task,
      { id: '2', status: 'completed', blockedBy: [] },
      { id: '3', status: 'cancelled', blockedBy: [] },
    ]);
    task.blockedBy.push('3');
    const handler = await taskGetModule.createHandler();
    const result = await handler.execute({ taskId: '1' }, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Blocked By: 2, 3 (all resolved)');
    }
  });
});

// ============================================================================
// TaskList (native ToolModule) Tests — Wave 3 planning
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/main/protocol/tools';

const listTasksMock = vi.fn();

vi.mock('../../../../../src/main/services/planning/taskStore', () => ({
  listTasks: (...args: unknown[]) => listTasksMock(...args),
}));

import { taskListModule } from '../../../../../src/main/tools/modules/planning/taskList';

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
});

describe('task_list schema', () => {
  it('对齐 legacy schema name/category/readOnly', () => {
    expect(taskListModule.schema.name).toBe('task_list');
    expect(taskListModule.schema.category).toBe('planning');
    expect(taskListModule.schema.permissionLevel).toBe('read');
    expect(taskListModule.schema.readOnly).toBe(true);
    expect(taskListModule.schema.allowInPlanMode).toBe(true);
  });
});

describe('task_list behavior', () => {
  it('canUseTool 拒绝 → PERMISSION_DENIED', async () => {
    const handler = await taskListModule.createHandler();
    const result = await handler.execute({}, makeCtx(), denyAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
  });

  it('已 abort → ABORTED', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const handler = await taskListModule.createHandler();
    const result = await handler.execute({}, makeCtx({ abortSignal: ctrl.signal }), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('无 task → 提示 + meta 不返回', async () => {
    listTasksMock.mockReturnValueOnce([]);
    const handler = await taskListModule.createHandler();
    const result = await handler.execute({}, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('No tasks in this session');
    }
  });

  it('有 task → 输出 1:1 复刻 + meta', async () => {
    listTasksMock.mockReturnValue([
      { id: '1', subject: 'do A', status: 'completed', owner: 'me', blockedBy: [], blocks: [], metadata: {} },
      { id: '2', subject: 'do B', status: 'in_progress', owner: undefined, blockedBy: ['1'], blocks: [], metadata: {} },
      { id: '3', subject: 'do C', status: 'pending', owner: undefined, blockedBy: ['2'], blocks: [], metadata: {} },
    ]);
    const handler = await taskListModule.createHandler();
    const result = await handler.execute({}, makeCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Tasks (1/3 completed):');
      expect(result.output).toContain('● #1: do A (@me)');
      expect(result.output).toContain('◐ #2: do B'); // not blocked because #1 is completed
      expect(result.output).not.toContain('◐ #2: do B [blocked');
      expect(result.output).toContain('○ #3: do C [blocked by: 2]');
      expect(result.output).toContain('Status: 1 completed, 1 in progress, 1 pending, 1 blocked');
      expect(result.meta?.stats).toEqual({ total: 3, completed: 1, inProgress: 1, pending: 1, blocked: 1 });
    }
  });

  it('sessionId fallback 到 "default"', async () => {
    listTasksMock.mockReturnValueOnce([]);
    const handler = await taskListModule.createHandler();
    const ctx = makeCtx();
    // 强制清空 sessionId
    Object.defineProperty(ctx, 'sessionId', { value: undefined });
    await handler.execute({}, ctx, allowAll);
    expect(listTasksMock).toHaveBeenCalledWith('default');
  });
});

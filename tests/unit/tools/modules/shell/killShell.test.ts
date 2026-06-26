import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';

const {
  killBackgroundTaskMock,
  isTaskIdMock,
  getAllBackgroundTasksMock,
  getBackgroundTaskMock,
} = vi.hoisted(() => ({
  killBackgroundTaskMock: vi.fn(),
  isTaskIdMock: vi.fn(),
  getAllBackgroundTasksMock: vi.fn(),
  getBackgroundTaskMock: vi.fn(),
}));

vi.mock('../../../../../src/host/tools/shell/backgroundTasks', () => ({
  killBackgroundTask: (...args: unknown[]) => killBackgroundTaskMock(...args),
  isTaskId: (...args: unknown[]) => isTaskIdMock(...args),
  getAllBackgroundTasks: (...args: unknown[]) => getAllBackgroundTasksMock(...args),
  getBackgroundTask: (...args: unknown[]) => getBackgroundTaskMock(...args),
}));

import { killShellModule } from '../../../../../src/host/tools/modules/shell/killShell';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'sess-1',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    currentToolCallId: 'tool-call-1',
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('killShellModule structured result metadata', () => {
  it('returns action, targets, session/thread and logPath on success', async () => {
    isTaskIdMock.mockReturnValue(true);
    killBackgroundTaskMock.mockReturnValue({ success: true, message: 'Killed task: task-1' });
    getBackgroundTaskMock.mockReturnValue({ taskId: 'task-1', outputFile: '/tmp/task.log' });

    const handler = await killShellModule.createHandler();
    const result = await handler.execute({ task_id: 'task-1' }, makeCtx(), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('Killed task: task-1');
      expect(result.meta).toMatchObject({
        action: 'kill',
        taskId: 'task-1',
        status: 'killed',
        targets: ['task-1'],
        session: 'sess-1',
        thread: 'tool-call-1',
        logPath: '/tmp/task.log',
        result: { success: true, message: 'Killed task: task-1' },
      });
    }
  });
});

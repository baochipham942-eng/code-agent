import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import { markShortTierSession, settleShortTierWait } from '../../../../../src/host/tools/shell/foregroundTier';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';

const {
  getAllBackgroundTasksMock,
  getTaskOutputMock,
  killBackgroundTaskMock,
  isTaskIdMock,
  getBackgroundTaskMock,
  getAllPtySessionsMock,
  getPtySessionOutputMock,
  getPtySessionLogMock,
  pollPtySessionMock,
  writeToPtySessionMock,
  submitToPtySessionMock,
  killPtySessionMock,
  isPtySessionIdMock,
} = vi.hoisted(() => ({
  getAllBackgroundTasksMock: vi.fn(),
  getTaskOutputMock: vi.fn(),
  killBackgroundTaskMock: vi.fn(),
  isTaskIdMock: vi.fn(),
  getBackgroundTaskMock: vi.fn(),
  getAllPtySessionsMock: vi.fn(),
  getPtySessionOutputMock: vi.fn(),
  getPtySessionLogMock: vi.fn(),
  pollPtySessionMock: vi.fn(),
  writeToPtySessionMock: vi.fn(),
  submitToPtySessionMock: vi.fn(),
  killPtySessionMock: vi.fn(),
  isPtySessionIdMock: vi.fn(),
}));

vi.mock('../../../../../src/host/tools/shell/backgroundTasks', () => ({
  getAllBackgroundTasks: (...args: unknown[]) => getAllBackgroundTasksMock(...args),
  getTaskOutput: (...args: unknown[]) => getTaskOutputMock(...args),
  killBackgroundTask: (...args: unknown[]) => killBackgroundTaskMock(...args),
  isTaskId: (...args: unknown[]) => isTaskIdMock(...args),
  getBackgroundTask: (...args: unknown[]) => getBackgroundTaskMock(...args),
}));

vi.mock('../../../../../src/host/tools/shell/ptyExecutor', () => ({
  getAllPtySessions: (...args: unknown[]) => getAllPtySessionsMock(...args),
  getPtySessionOutput: (...args: unknown[]) => getPtySessionOutputMock(...args),
  getPtySessionLog: (...args: unknown[]) => getPtySessionLogMock(...args),
  pollPtySession: (...args: unknown[]) => pollPtySessionMock(...args),
  writeToPtySession: (...args: unknown[]) => writeToPtySessionMock(...args),
  submitToPtySession: (...args: unknown[]) => submitToPtySessionMock(...args),
  killPtySession: (...args: unknown[]) => killPtySessionMock(...args),
  isPtySessionId: (...args: unknown[]) => isPtySessionIdMock(...args),
}));

import { processModule } from '../../../../../src/host/tools/modules/shell/process';

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

describe('processModule structured result metadata', () => {
  let tmpDir: string;
  let outputFile: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'process-tool-'));
    outputFile = path.join(tmpDir, 'task.log');
    await fs.writeFile(outputFile, 'process log\n', 'utf8');
    getAllBackgroundTasksMock.mockReturnValue([]);
    getAllPtySessionsMock.mockReturnValue([]);
    isTaskIdMock.mockReturnValue(false);
    isPtySessionIdMock.mockReturnValue(false);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('list returns counts and a virtual process-output artifact', async () => {
    getAllBackgroundTasksMock.mockReturnValue([
      { taskId: 'task-1', status: 'running', command: 'npm run dev', duration: 1500, outputFile },
    ]);
    getAllPtySessionsMock.mockReturnValue([
      { sessionId: 'pty-1', status: 'completed', command: 'node', args: ['repl'], duration: 2000, exitCode: 0, cols: 80, rows: 24 },
    ]);

    const handler = await processModule.createHandler();
    const result = await handler.execute({ action: 'list' }, makeCtx(), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Found 2 process(es)');
      expect(result.meta).toMatchObject({
        action: 'list',
        status: 'listed',
        session: 'sess-1',
        thread: 'tool-call-1',
        targets: ['task-1', 'pty-1'],
        counts: { processes: 2, background: 1, pty: 1, running: 1, completed: 1 },
        permissionClass: 'observe',
        artifact: expect.objectContaining({
          kind: 'process-output',
          sourceTool: 'Process',
        }),
      });
    }
  });

  it('output returns a process-log file artifact when the task has an output file', async () => {
    isTaskIdMock.mockReturnValue(true);
    getTaskOutputMock.mockResolvedValue({
      status: 'completed',
      output: 'process log',
      exitCode: 0,
      duration: 3000,
    });
    getBackgroundTaskMock.mockReturnValue({
      taskId: 'task-1',
      status: 'completed',
      command: 'echo ok',
      outputFile,
    });

    const handler = await processModule.createHandler();
    const result = await handler.execute({ action: 'output', task_id: 'task-1' }, makeCtx(), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toMatchObject({
        action: 'output',
        permissionClass: 'observe',
        taskId: 'task-1',
        status: 'completed',
        exitCode: 0,
        duration: 3000,
        logPath: outputFile,
        artifact: expect.objectContaining({
          kind: 'process-log',
          sourceTool: 'Process',
          path: outputFile,
          metadata: expect.objectContaining({
            action: 'output',
            taskId: 'task-1',
          }),
        }),
      });
    }
  });

  it('short-tier sessions refuse blocking waits above the tier; interactive sessions do not', async () => {
    isTaskIdMock.mockReturnValue(true);
    getTaskOutputMock.mockResolvedValue({ status: 'running', output: '', exitCode: null, duration: 1 });
    getBackgroundTaskMock.mockReturnValue({ taskId: 'task-1', status: 'running', command: 'x' });
    const sessionId = `short-process-${Date.now()}`;
    markShortTierSession(sessionId);
    const handler = await processModule.createHandler();

    const refused = await handler.execute({ action: 'output', task_id: 'task-1', timeout: 60000 }, makeCtx({ sessionId }), allowAll);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('arrive automatically');

    const interactive = await handler.execute({ action: 'output', task_id: 'task-1', timeout: 60000 }, makeCtx(), allowAll);
    expect(interactive.ok).toBe(true);
  });

  it('r3 累计 no-wait 预算：预算耗尽后阻塞轮询被拒，已终态任务与非阻塞读取不受影响', async () => {
    isTaskIdMock.mockReturnValue(true);
    getTaskOutputMock.mockResolvedValue({ status: 'running', output: '', exitCode: null, duration: 1 });
    getBackgroundTaskMock.mockReturnValue({ taskId: 'task-1', status: 'running', command: 'x' });
    const sessionId = `short-budget-${Date.now()}`;
    markShortTierSession(sessionId);
    const handler = await processModule.createHandler();

    // 预算还有余量：放行且等待上限被压到余量（r2 e2e 实录的第二条无 timeout 轮询正是这样拖满回合）。
    settleShortTierWait(sessionId, 4000);
    const granted = await handler.execute({ action: 'output', task_id: 'task-1' }, makeCtx({ sessionId }), allowAll);
    expect(granted.ok).toBe(true);
    expect(getTaskOutputMock).toHaveBeenLastCalledWith('task-1', true, 6000);

    // 预算耗尽：同一会话继续阻塞等（output 与 poll）都被拒，并带「结果自动送达」提示。
    settleShortTierWait(sessionId, 6000);
    const refusedOutput = await handler.execute({ action: 'output', task_id: 'task-1' }, makeCtx({ sessionId }), allowAll);
    expect(refusedOutput.ok).toBe(false);
    if (!refusedOutput.ok) expect(refusedOutput.error).toContain('arrive automatically');

    const refusedPoll = await handler.execute({ action: 'poll', session_id: 'task-1', block: true }, makeCtx({ sessionId }), allowAll);
    expect(refusedPoll.ok).toBe(false);
    if (!refusedPoll.ok) expect(refusedPoll.error).toContain('arrive automatically');

    // 已终态任务的读取永不计量：任务完成后随时能读全量输出（通知之外的兜底读取路径）。
    getBackgroundTaskMock.mockReturnValue({ taskId: 'task-1', status: 'completed', command: 'x' });
    getTaskOutputMock.mockResolvedValue({ status: 'completed', output: 'done', exitCode: 0, duration: 1 });
    const completed = await handler.execute({ action: 'output', task_id: 'task-1' }, makeCtx({ sessionId }), allowAll);
    expect(completed.ok).toBe(true);

    // 非阻塞读取不受预算影响。
    getBackgroundTaskMock.mockReturnValue({ taskId: 'task-1', status: 'running', command: 'x' });
    getTaskOutputMock.mockResolvedValue({ status: 'running', output: '', exitCode: null, duration: 1 });
    const nonBlock = await handler.execute({ action: 'output', task_id: 'task-1', block: false }, makeCtx({ sessionId }), allowAll);
    expect(nonBlock.ok).toBe(true);
  });

  it('poll appends the sandbox denial path for a failed PTY', async () => {
    isPtySessionIdMock.mockReturnValue(true);
    pollPtySessionMock.mockReturnValue({
      success: true,
      status: 'failed',
      data: '',
      exitCode: 1,
    });
    getPtySessionOutputMock.mockResolvedValue({
      status: 'failed',
      output: '/bin/sh: /Users/tester/x: Operation not permitted',
      exitCode: 1,
      duration: 20,
    });
    getAllPtySessionsMock.mockReturnValue([{
      sessionId: 'pty-1',
      status: 'failed',
      command: 'touch ~/x',
      args: [],
      cwd: '/tmp/project',
      sandboxed: true,
    }]);

    const handler = await processModule.createHandler();
    const result = await handler.execute(
      { action: 'poll', session_id: 'pty-1', block: false },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('沙盒拒绝：/Users/tester/x');
  });

  it('poll appends the sandbox denial path for a failed background task', async () => {
    isTaskIdMock.mockReturnValue(true);
    getTaskOutputMock.mockResolvedValue({
      status: 'failed',
      output: '[stderr] /bin/sh: /Users/tester/x: Operation not permitted',
      exitCode: 1,
      duration: 20,
    });
    getBackgroundTaskMock.mockReturnValue({
      taskId: 'task-1',
      status: 'failed',
      command: 'touch ~/x',
      cwd: '/tmp/project',
      sandboxed: true,
      outputFile,
    });

    const handler = await processModule.createHandler();
    const result = await handler.execute(
      { action: 'poll', session_id: 'task-1', block: true },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('沙盒拒绝：/Users/tester/x');
  });
});

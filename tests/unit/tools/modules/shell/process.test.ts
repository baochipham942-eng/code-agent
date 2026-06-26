import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/main/protocol/tools';

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

vi.mock('../../../../../src/main/tools/shell/backgroundTasks', () => ({
  getAllBackgroundTasks: (...args: unknown[]) => getAllBackgroundTasksMock(...args),
  getTaskOutput: (...args: unknown[]) => getTaskOutputMock(...args),
  killBackgroundTask: (...args: unknown[]) => killBackgroundTaskMock(...args),
  isTaskId: (...args: unknown[]) => isTaskIdMock(...args),
  getBackgroundTask: (...args: unknown[]) => getBackgroundTaskMock(...args),
}));

vi.mock('../../../../../src/main/tools/shell/ptyExecutor', () => ({
  getAllPtySessions: (...args: unknown[]) => getAllPtySessionsMock(...args),
  getPtySessionOutput: (...args: unknown[]) => getPtySessionOutputMock(...args),
  getPtySessionLog: (...args: unknown[]) => getPtySessionLogMock(...args),
  pollPtySession: (...args: unknown[]) => pollPtySessionMock(...args),
  writeToPtySession: (...args: unknown[]) => writeToPtySessionMock(...args),
  submitToPtySession: (...args: unknown[]) => submitToPtySessionMock(...args),
  killPtySession: (...args: unknown[]) => killPtySessionMock(...args),
  isPtySessionId: (...args: unknown[]) => isPtySessionIdMock(...args),
}));

import { processModule } from '../../../../../src/main/tools/modules/shell/process';

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
});

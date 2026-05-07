import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/main/protocol/tools';

const {
  getTaskOutputMock,
  getAllBackgroundTasksMock,
  isTaskIdMock,
  getBackgroundTaskMock,
} = vi.hoisted(() => ({
  getTaskOutputMock: vi.fn(),
  getAllBackgroundTasksMock: vi.fn(),
  isTaskIdMock: vi.fn(),
  getBackgroundTaskMock: vi.fn(),
}));

vi.mock('../../../../../src/main/tools/shell/backgroundTasks', () => ({
  getTaskOutput: (...args: unknown[]) => getTaskOutputMock(...args),
  getAllBackgroundTasks: (...args: unknown[]) => getAllBackgroundTasksMock(...args),
  isTaskId: (...args: unknown[]) => isTaskIdMock(...args),
  getBackgroundTask: (...args: unknown[]) => getBackgroundTaskMock(...args),
}));

import { taskOutputModule } from '../../../../../src/main/tools/modules/shell/taskOutput';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('taskOutputModule', () => {
  let tmpDir: string;
  let outputFile: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-output-'));
    outputFile = path.join(tmpDir, 'task.log');
    await fs.writeFile(outputFile, 'hello task log\n', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('lists background tasks with structured metadata', async () => {
    getAllBackgroundTasksMock.mockReturnValue([
      {
        taskId: 'task-1',
        status: 'running',
        command: 'npm run dev',
        duration: 1500,
        outputFile,
      },
    ]);

    const handler = await taskOutputModule.createHandler();
    const result = await handler.execute({}, makeCtx(), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('Found 1 background task');
      expect(result.meta).toMatchObject({
        taskCount: 1,
        tasks: [expect.objectContaining({ taskId: 'task-1', status: 'running' })],
        artifact: expect.objectContaining({
          kind: 'process-output',
          sourceTool: 'task_output',
        }),
      });
    }
  });

  it('returns task output with process-log file artifact', async () => {
    isTaskIdMock.mockReturnValue(true);
    getTaskOutputMock.mockResolvedValue({
      taskId: 'task-1',
      status: 'completed',
      output: 'hello task log',
      exitCode: 0,
      duration: 2500,
    });
    getBackgroundTaskMock.mockReturnValue({
      taskId: 'task-1',
      status: 'completed',
      command: 'echo hello',
      outputFile,
    });

    const handler = await taskOutputModule.createHandler();
    const result = await handler.execute({ task_id: 'task-1' }, makeCtx(), allowAll);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('hello task log');
      expect(result.meta?.artifact).toMatchObject({
        kind: 'process-log',
        sourceTool: 'task_output',
        path: outputFile,
        mimeType: 'text/plain',
        metadata: {
          taskId: 'task-1',
          status: 'completed',
          exitCode: 0,
          duration: 2500,
          command: 'echo hello',
        },
      });
      expect(result.meta?.outputFile).toBe(outputFile);
    }
  });
});

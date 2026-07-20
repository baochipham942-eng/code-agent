import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS, type IPCResponse } from '../../../src/shared/ipc';
import { BACKGROUND_TASK_LOG } from '../../../src/shared/constants';

const sourceMocks = vi.hoisted(() => ({
  getAllBackgroundTasks: vi.fn(() => []),
  getAllPtySessions: vi.fn(() => []),
  onBackgroundTaskLifecycleEvent: vi.fn(() => () => {}),
  onPtySessionLifecycleEvent: vi.fn(() => () => {}),
}));

vi.mock('../../../src/host/tools/modules/shell/backgroundTaskSources', () => ({
  getAllBackgroundTasks: sourceMocks.getAllBackgroundTasks,
  getAllPtySessions: sourceMocks.getAllPtySessions,
  onBackgroundTaskLifecycleEvent: sourceMocks.onBackgroundTaskLifecycleEvent,
  onPtySessionLifecycleEvent: sourceMocks.onPtySessionLifecycleEvent,
}));

import { registerBackgroundTaskLedgerHandlers } from '../../../src/host/ipc/backgroundTaskLedger.ipc';
import {
  getBackgroundTaskLedger,
  resetBackgroundTaskLedgerForTest,
} from '../../../src/host/task/backgroundTaskLedger';
import { resetBackgroundTaskEventAdaptersForTest } from '../../../src/host/task/backgroundTaskSnapshotAdapters';

type DomainHandler = (_: unknown, request: unknown) => Promise<IPCResponse>;

function makeFakeIpc(): { handle: Mock; getHandler: () => DomainHandler } {
  const registry = new Map<string, DomainHandler>();
  const handle = vi.fn((channel: string, fn: DomainHandler) => {
    registry.set(channel, fn);
  });
  return {
    handle,
    getHandler: () => {
      const fn = registry.get(IPC_DOMAINS.BACKGROUND_TASKS);
      if (!fn) throw new Error('BACKGROUND_TASKS handler not registered');
      return fn;
    },
  };
}

describe('background task ledger typed IPC', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    resetBackgroundTaskEventAdaptersForTest();
    resetBackgroundTaskLedgerForTest();
    vi.clearAllMocks();
    sourceMocks.getAllBackgroundTasks.mockReturnValue([]);
    sourceMocks.getAllPtySessions.mockReturnValue([]);
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'background-task-log-'));
    tempDirs.push(dir);
    return dir;
  }

  function registerTaskLog(taskId: string, refId: string, logPath?: string): DomainHandler {
    const ledger = getBackgroundTaskLedger();
    ledger.upsertTask({ id: taskId, source: 'test', title: taskId });
    ledger.addOutputRef({
      id: refId,
      taskId,
      type: 'log',
      path: logPath,
    });
    const ipc = makeFakeIpc();
    registerBackgroundTaskLedgerHandlers(ipc as never);
    return ipc.getHandler();
  }

  it('validates request payload before dispatching to the ledger', async () => {
    const ipc = makeFakeIpc();
    registerBackgroundTaskLedgerHandlers(ipc as never);

    const response = await ipc.getHandler()({}, {
      action: 'getTask',
      payload: {},
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
  });

  it('lists tasks through the typed domain request schema', async () => {
    const ledger = getBackgroundTaskLedger();
    ledger.upsertTask({
      id: 'task-typed',
      sessionId: 'session-typed',
      source: 'test',
      title: 'Typed task',
      status: 'running',
    });

    const ipc = makeFakeIpc();
    registerBackgroundTaskLedgerHandlers(ipc as never);

    const response = await ipc.getHandler()({}, {
      action: 'listTasks',
      payload: { sessionId: 'session-typed' },
    });

    expect(response).toMatchObject({
      success: true,
      data: [
        {
          id: 'task-typed',
          sessionId: 'session-typed',
          title: 'Typed task',
          status: 'running',
        },
      ],
    });
  });

  it('drains notifications through the typed domain request schema', async () => {
    const ledger = getBackgroundTaskLedger();
    ledger.upsertTask({
      id: 'task-notice',
      sessionId: 'session-notice',
      source: 'test',
      title: 'Notice task',
    });
    ledger.queueNotification({
      id: 'notice-1',
      taskId: 'task-notice',
      sessionId: 'session-notice',
      type: 'task_completed',
      message: 'Done',
    });

    const ipc = makeFakeIpc();
    registerBackgroundTaskLedgerHandlers(ipc as never);

    const response = await ipc.getHandler()({}, {
      action: 'drainNotifications',
      payload: { sessionId: 'session-notice' },
    });

    expect(response).toMatchObject({
      success: true,
      data: [
        {
          id: 'notice-1',
          taskId: 'task-notice',
          sessionId: 'session-notice',
          type: 'task_completed',
          message: 'Done',
        },
      ],
    });
    expect(ledger.drainNotifications('session-notice')).toEqual([]);
  });

  it('reads a registered task log without accepting a renderer path', async () => {
    const dir = await createTempDir();
    const logPath = path.join(dir, 'task.log');
    await writeFile(logPath, 'line one\nline two\n', 'utf8');
    const handler = registerTaskLog('task-log', 'task-log:ref', logPath);

    const response = await handler({}, {
      action: 'readTaskLog',
      payload: { taskId: 'task-log', refId: 'task-log:ref' },
    });

    expect(response).toEqual({
      success: true,
      data: {
        content: 'line one\nline two\n',
        truncated: false,
        size: 18,
      },
    });
  });

  it('reads only the configured tail when a registered log exceeds the limit', async () => {
    const dir = await createTempDir();
    const logPath = path.join(dir, 'large.log');
    const content = `discard-me:${'x'.repeat(BACKGROUND_TASK_LOG.TAIL_MAX_BYTES)}`;
    await writeFile(logPath, content, 'utf8');
    const handler = registerTaskLog('task-large-log', 'task-large-log:ref', logPath);

    const response = await handler({}, {
      action: 'readTaskLog',
      payload: { taskId: 'task-large-log', refId: 'task-large-log:ref' },
    });

    expect(response).toEqual({
      success: true,
      data: {
        content: 'x'.repeat(BACKGROUND_TASK_LOG.TAIL_MAX_BYTES),
        truncated: true,
        size: Buffer.byteLength(content),
      },
    });
  });

  it('returns explicit errors for unknown tasks, refs, and missing files', async () => {
    const ipc = makeFakeIpc();
    registerBackgroundTaskLedgerHandlers(ipc as never);
    const handler = ipc.getHandler();

    await expect(handler({}, {
      action: 'readTaskLog',
      payload: { taskId: 'missing-task', refId: 'missing-ref' },
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'BACKGROUND_TASK_NOT_FOUND' },
    });

    const ledger = getBackgroundTaskLedger();
    ledger.upsertTask({ id: 'task-errors', source: 'test', title: 'Errors' });
    await expect(handler({}, {
      action: 'readTaskLog',
      payload: { taskId: 'task-errors', refId: 'missing-ref' },
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'BACKGROUND_TASK_LOG_REF_NOT_FOUND' },
    });

    ledger.addOutputRef({
      id: 'missing-file-ref',
      taskId: 'task-errors',
      type: 'log',
      path: path.join(await createTempDir(), 'missing.log'),
    });
    await expect(handler({}, {
      action: 'readTaskLog',
      payload: { taskId: 'task-errors', refId: 'missing-file-ref' },
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'BACKGROUND_TASK_LOG_FILE_NOT_FOUND' },
    });
  });

  it('returns an explicit unreadable error for a registered non-file path', async () => {
    const dir = await createTempDir();
    const handler = registerTaskLog('task-directory-log', 'task-directory-log:ref', dir);

    const response = await handler({}, {
      action: 'readTaskLog',
      payload: { taskId: 'task-directory-log', refId: 'task-directory-log:ref' },
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'BACKGROUND_TASK_LOG_FILE_UNREADABLE' },
    });
  });

  it('rejects renderer-supplied paths at the request schema boundary', async () => {
    const ipc = makeFakeIpc();
    registerBackgroundTaskLedgerHandlers(ipc as never);

    const response = await ipc.getHandler()({}, {
      action: 'readTaskLog',
      payload: { taskId: 'task-log', refId: 'task-log:ref', path: '/tmp/injected.log' },
    });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'INVALID_PAYLOAD' },
    });
  });
});

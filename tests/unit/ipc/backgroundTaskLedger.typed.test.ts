import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS, type IPCResponse } from '../../../src/shared/ipc';

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
} from '../../../src/host/tasks/backgroundTaskLedger';
import { resetBackgroundTaskEventAdaptersForTest } from '../../../src/host/tasks/backgroundTaskSnapshotAdapters';

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
  beforeEach(() => {
    resetBackgroundTaskEventAdaptersForTest();
    resetBackgroundTaskLedgerForTest();
    vi.clearAllMocks();
    sourceMocks.getAllBackgroundTasks.mockReturnValue([]);
    sourceMocks.getAllPtySessions.mockReturnValue([]);
  });

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
});

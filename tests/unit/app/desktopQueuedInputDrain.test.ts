import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import type { AgentEvent } from '../../../src/shared/contract';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import { QUEUED_INPUT_RETRY } from '../../../src/shared/constants/queuedInput';

const orchestratorMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/platform', () => ({
  app: { getPath: () => '/tmp' },
  AppWindow: { getAllWindows: () => [] },
}));

vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({
    addMessageToSession: vi.fn(),
    updateMessage: vi.fn(),
    getSession: vi.fn(),
  }),
  notificationService: {
    notifyNeedsInput: vi.fn(),
    notifyTaskComplete: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    isReady: true,
    updateSession: vi.fn(),
  }),
}));

vi.mock('../../../src/host/agent/agentOrchestrator', () => ({
  AgentOrchestrator: class {
    sendMessage = (...args: unknown[]) => orchestratorMocks.sendMessage(...args);
    cancel = () => orchestratorMocks.cancel();
    setSessionId = vi.fn();
    setPlanningService = vi.fn();
    setMessages = vi.fn();
    setWorkingDirectory = vi.fn();
    handlePermissionResponse = vi.fn();
  },
}));

import { registerDesktopQueuedInputDrain } from '../../../src/host/app/desktopQueuedInputDrain';
import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';
import { TaskManager } from '../../../src/host/task/TaskManager';

class TestTaskManager extends EventEmitter {
  readonly agentEvents: Array<{ sessionId: string; event: AgentEvent }> = [];

  transition(sessionId: string, status: string): void {
    this.emit('state_change', {
      type: 'state_change',
      sessionId,
      data: { status },
    });
  }

  emitAgentEventForSession(sessionId: string, event: AgentEvent): void {
    this.agentEvents.push({ sessionId, event });
  }
}

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE queued_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_queued_inputs_session
      ON queued_inputs (session_id, status, created_at);
  `);
}

describe('desktop queued input drain', () => {
  const databases: BetterSqlite3.Database[] = [];
  const unregisterCallbacks: Array<() => void> = [];

  function createRepository(): QueuedInputRepository {
    const db = new Database(':memory:');
    createSchema(db);
    databases.push(db);
    return new QueuedInputRepository(db);
  }

  function register(
    taskManager: TestTaskManager | TaskManager,
    appService: { sendMessage: (envelope: ConversationEnvelope) => Promise<void> },
    repository: QueuedInputRepository,
  ): void {
    unregisterCallbacks.push(registerDesktopQueuedInputDrain({
      taskManager,
      appService,
      repository,
    }));
  }

  function createRealTaskManager(): TaskManager {
    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({
      configService: {} as never,
      onAgentEvent: vi.fn(),
    });
    return manager;
  }

  beforeEach(() => {
    orchestratorMocks.sendMessage.mockReset();
    orchestratorMocks.cancel.mockReset();
  });

  afterEach(() => {
    for (const unregister of unregisterCallbacks.splice(0)) {
      unregister();
    }
    for (const db of databases.splice(0)) {
      db.close();
    }
  });

  it('drains only after normal completion has released the real TaskManager slot', async () => {
    const repository = createRepository();
    repository.enqueue({
      id: 'queued-normal',
      sessionId: 'session-normal',
      envelope: { content: 'follow normal' },
      now: 1,
    });
    const manager = createRealTaskManager();
    const sendMessage = vi.fn(async () => {
      expect(manager.getStats().available).toBe(1);
    });
    register(manager, { sendMessage }, repository);
    orchestratorMocks.sendMessage.mockResolvedValue(undefined);

    await manager.startTask('session-normal', 'current turn');

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: 'follow normal',
      clientMessageId: 'queued-normal',
      sessionId: 'session-normal',
    }));
    expect(repository.getById('queued-normal')?.status).toBe('consumed');
  });

  it('drains after an errored turn reaches idle following TaskManager cleanup', async () => {
    const repository = createRepository();
    repository.enqueue({
      id: 'queued-error',
      sessionId: 'session-error',
      envelope: { content: 'follow error' },
      now: 1,
    });
    const manager = createRealTaskManager();
    const sendMessage = vi.fn(async () => {
      expect(manager.getStats().available).toBe(1);
      expect(manager.getSessionState('session-error').status).toBe('idle');
    });
    register(manager, { sendMessage }, repository);
    orchestratorMocks.sendMessage.mockRejectedValue(new Error('turn failed'));

    await manager.startTask('session-error', 'current turn');

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(repository.getById('queued-error')?.status).toBe('consumed');
  });

  it('drains after cancellation reaches idle and releases the real TaskManager slot', async () => {
    const repository = createRepository();
    repository.enqueue({
      id: 'queued-cancel',
      sessionId: 'session-cancel',
      envelope: { content: 'follow cancel' },
      now: 1,
    });
    const manager = createRealTaskManager();
    const sendMessage = vi.fn(async () => {
      expect(manager.getStats().available).toBe(1);
    });
    register(manager, { sendMessage }, repository);

    let finishTurn: (() => void) | undefined;
    orchestratorMocks.sendMessage.mockImplementation(() => new Promise<void>((resolve) => {
      finishTurn = resolve;
    }));
    orchestratorMocks.cancel.mockImplementation(async () => {
      finishTurn?.();
    });

    const run = manager.startTask('session-cancel', 'current turn');
    await vi.waitFor(() => expect(orchestratorMocks.sendMessage).toHaveBeenCalledTimes(1));
    await manager.cancelTask('session-cancel');
    await run;

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(repository.getById('queued-cancel')?.status).toBe('consumed');
  });

  it('does not double-drain when the same session emits duplicate idle events', async () => {
    const repository = createRepository();
    repository.enqueue({
      id: 'queued-once',
      sessionId: 'session-once',
      envelope: { content: 'only once' },
      now: 1,
    });
    const manager = new TestTaskManager();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    register(manager, { sendMessage }, repository);

    manager.transition('session-once', 'running');
    manager.transition('session-once', 'idle');
    manager.transition('session-once', 'idle');

    await vi.waitFor(() => expect(repository.getById('queued-once')?.status).toBe('consumed'));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('requeues through the shared retry ceiling, then marks failed and emits a user-visible error', async () => {
    const repository = createRepository();
    repository.enqueue({
      id: 'queued-retry',
      sessionId: 'session-retry',
      envelope: { content: 'retry me' },
      now: 1,
    });
    const manager = new TestTaskManager();
    const sendMessage = vi.fn().mockRejectedValue(new Error('send failed'));
    register(manager, { sendMessage }, repository);

    for (let attempt = 1; attempt <= QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS; attempt += 1) {
      manager.transition('session-retry', 'running');
      manager.transition('session-retry', 'idle');
      await vi.waitFor(() => {
        expect(repository.getById('queued-retry')).toMatchObject({
          status: 'queued',
          retryCount: attempt,
        });
      });
      expect(manager.agentEvents).toHaveLength(0);
    }

    manager.transition('session-retry', 'running');
    manager.transition('session-retry', 'idle');

    await vi.waitFor(() => {
      expect(repository.getById('queued-retry')).toMatchObject({
        status: 'failed',
        retryCount: QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS + 1,
      });
    });
    expect(sendMessage).toHaveBeenCalledTimes(QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS + 1);
    expect(manager.agentEvents).toEqual([{
      sessionId: 'session-retry',
      event: {
        type: 'error',
        data: {
          code: 'QUEUED_INPUT_SEND_FAILED',
          message: 'send failed',
        },
      },
    }]);
  });

  it('drains multiple records serially in createdAt order through real busy-to-idle turns', async () => {
    const repository = createRepository();
    repository.enqueue({
      id: 'queued-later',
      sessionId: 'session-serial',
      envelope: { content: 'later' },
      now: 20,
    });
    repository.enqueue({
      id: 'queued-earlier',
      sessionId: 'session-serial',
      envelope: { content: 'earlier' },
      now: 10,
    });
    const manager = new TestTaskManager();
    const sentIds: string[] = [];
    let concurrentSends = 0;
    let maxConcurrentSends = 0;
    const sendMessage = vi.fn(async (envelope: ConversationEnvelope) => {
      concurrentSends += 1;
      maxConcurrentSends = Math.max(maxConcurrentSends, concurrentSends);
      sentIds.push(envelope.clientMessageId ?? 'missing');
      manager.transition('session-serial', 'running');
      manager.transition('session-serial', 'idle');
      concurrentSends -= 1;
    });
    register(manager, { sendMessage }, repository);

    manager.transition('session-serial', 'running');
    manager.transition('session-serial', 'idle');

    await vi.waitFor(() => {
      expect(repository.listBySession('session-serial', 'consumed')).toHaveLength(2);
    });
    expect(sentIds).toEqual(['queued-earlier', 'queued-later']);
    expect(maxConcurrentSends).toBe(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { Response } from 'express';

import type { AgentEvent } from '../../../src/shared/contract';
import type { ConversationEnvelope } from '../../../src/shared/contract/conversationEnvelope';
import { QUEUED_INPUT_RETRY } from '../../../src/shared/constants/queuedInput';
import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';
import { sendSSE, sseClients } from '../../../src/web/helpers/sse';
import {
  createWebQueuedInputDrain,
  releaseThenTriggerWebQueuedInputDrain,
  type WebQueuedInputDrain,
} from '../../../src/web/routes/webQueuedInputDrain';

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

describe('web queued input drain', () => {
  const databases: BetterSqlite3.Database[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  function createRepository(): QueuedInputRepository {
    const db = new Database(':memory:');
    createSchema(db);
    databases.push(db);
    return new QueuedInputRepository(db);
  }

  function createDrain(input: {
    repository: QueuedInputRepository;
    runEnvelope: (envelope: ConversationEnvelope, response: Response) => Promise<void>;
    agentEvents?: Array<{ sessionId: string; event: AgentEvent }>;
  }): WebQueuedInputDrain {
    return createWebQueuedInputDrain({
      getRepository: () => input.repository,
      runEnvelope: input.runEnvelope,
      emitAgentEvent: (sessionId, event) => input.agentEvents?.push({ sessionId, event }),
      logger,
    });
  }

  afterEach(() => {
    sseClients.clear();
    vi.clearAllMocks();
    for (const db of databases.splice(0)) {
      db.close();
    }
  });

  it('does not trigger drain until durable release has completed', async () => {
    let finishRelease: (() => void) | undefined;
    const release = vi.fn(() => new Promise<void>((resolve) => {
      finishRelease = resolve;
    }));
    const triggerDrain = vi.fn();

    const settlement = releaseThenTriggerWebQueuedInputDrain({
      release,
      sessionId: 'session-release',
      triggerDrain,
    });

    await Promise.resolve();
    expect(triggerDrain).not.toHaveBeenCalled();

    finishRelease?.();
    await settlement;
    expect(triggerDrain).toHaveBeenCalledOnce();
    expect(triggerDrain).toHaveBeenCalledWith('session-release');
  });

  it('runs with no SSE consumer attached and uses the persisted envelope identity', async () => {
    const repository = createRepository();
    repository.enqueue({
      id: 'queued-offline',
      sessionId: 'session-offline',
      envelope: {
        content: 'continue offline',
        clientMessageId: 'stale-id',
        sessionId: 'stale-session',
        context: { workingDirectory: '/tmp/offline-workspace' },
      },
      now: 1,
    });
    const seen: ConversationEnvelope[] = [];
    const drain = createDrain({
      repository,
      runEnvelope: async (envelope, response) => {
        expect(sseClients.size).toBe(0);
        expect(response.destroyed).toBe(false);
        expect(response.writableEnded).toBe(false);
        expect(response.once('close', vi.fn())).toBe(response);
        expect(response.off('close', vi.fn())).toBe(response);
        sendSSE(response, 'task_start', { sessionId: envelope.sessionId });
        response.end();
        expect(response.writableEnded).toBe(true);
        seen.push(envelope);
      },
    });

    drain.handleReleasedSession('session-offline');

    await vi.waitFor(() => {
      expect(repository.getById('queued-offline')?.status).toBe('consumed');
    });
    expect(seen).toEqual([expect.objectContaining({
      content: 'continue offline',
      clientMessageId: 'queued-offline',
      sessionId: 'session-offline',
    })]);
  });

  it('requeues through the shared retry ceiling, then marks failed and broadcasts an error', async () => {
    const repository = createRepository();
    repository.enqueue({
      id: 'queued-retry',
      sessionId: 'session-retry',
      envelope: { content: 'retry web run' },
      now: 1,
    });
    const agentEvents: Array<{ sessionId: string; event: AgentEvent }> = [];
    const runEnvelope = vi.fn().mockRejectedValue(new Error('web run failed'));
    const drain = createDrain({ repository, runEnvelope, agentEvents });

    for (let attempt = 1; attempt <= QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS; attempt += 1) {
      drain.handleReleasedSession('session-retry');
      await vi.waitFor(() => {
        expect(repository.getById('queued-retry')).toMatchObject({
          status: 'queued',
          retryCount: attempt,
        });
      });
      expect(agentEvents).toHaveLength(0);
    }

    drain.handleReleasedSession('session-retry');
    await vi.waitFor(() => {
      expect(repository.getById('queued-retry')).toMatchObject({
        status: 'failed',
        retryCount: QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS + 1,
      });
    });
    expect(runEnvelope).toHaveBeenCalledTimes(QUEUED_INPUT_RETRY.MAX_RESEND_ATTEMPTS + 1);
    expect(agentEvents).toEqual([{
      sessionId: 'session-retry',
      event: {
        type: 'error',
        data: {
          code: 'QUEUED_INPUT_SEND_FAILED',
          message: 'web run failed',
        },
      },
    }]);
  });

  it('drains multiple records strictly serially in createdAt order', async () => {
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
    const sentIds: string[] = [];
    let concurrentRuns = 0;
    let maxConcurrentRuns = 0;
    const drain: WebQueuedInputDrain = createDrain({
      repository,
      runEnvelope: async (envelope) => {
        concurrentRuns += 1;
        maxConcurrentRuns = Math.max(maxConcurrentRuns, concurrentRuns);
        sentIds.push(envelope.clientMessageId ?? 'missing');
        // A drained run's own release is the trigger for the next record.
        drain.handleReleasedSession('session-serial');
        await Promise.resolve();
        concurrentRuns -= 1;
      },
    });

    drain.handleReleasedSession('session-serial');

    await vi.waitFor(() => {
      expect(repository.listBySession('session-serial', 'consumed')).toHaveLength(2);
    });
    expect(sentIds).toEqual(['queued-earlier', 'queued-later']);
    expect(maxConcurrentRuns).toBe(1);
  });
});

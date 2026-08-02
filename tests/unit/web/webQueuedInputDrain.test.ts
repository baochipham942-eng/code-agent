import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { Response } from 'express';

import type { AgentEvent } from '../../../src/shared/contract';
import type { QueuedInputSettledEvent } from '../../../src/shared/contract/queuedInput';
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
    settled?: QueuedInputSettledEvent[];
    hasActiveRun?: (sessionId: string) => boolean;
  }): WebQueuedInputDrain {
    return createWebQueuedInputDrain({
      getRepository: () => input.repository,
      hasActiveRun: input.hasActiveRun ?? (() => false),
      runEnvelope: input.runEnvelope,
      emitAgentEvent: (sessionId, event) => input.agentEvents?.push({ sessionId, event }),
      notifyQueuedInputSettled: (event) => input.settled?.push(event),
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

  // 真机 2026-08-01：上一轮刚回复完就发下一条，消息进了排队卡却再也没被发出去。
  // 原因是 drain 只在 run release 时触发，而这条是在 release 之后才入队的——
  // 那次 drain 早跑完了，没有任何人再来看这条。
  it('入队时 session 已空闲就立刻抽，不必等下一次 release', async () => {
    const repository = createRepository();
    const ran: string[] = [];
    const drain = createDrain({
      repository,
      hasActiveRun: () => false,
      runEnvelope: async (envelope) => { ran.push(envelope.content); },
    });

    repository.enqueue({
      id: 'queued-idle',
      sessionId: 'session-idle',
      envelope: { content: '入队时已空闲', sessionId: 'session-idle' },
      now: 1,
    });
    drain.handleEnqueued('session-idle');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ran).toEqual(['入队时已空闲']);
    expect(repository.getById('queued-idle')?.status).toBe('consumed');
  });

  it('入队时还有 run 在跑就不抽——那才是「排到下一轮」的正常语义', async () => {
    const repository = createRepository();
    const ran: string[] = [];
    const drain = createDrain({
      repository,
      hasActiveRun: () => true,
      runEnvelope: async (envelope) => { ran.push(envelope.content); },
    });

    repository.enqueue({
      id: 'queued-busy',
      sessionId: 'session-busy',
      envelope: { content: '这条要等下一轮', sessionId: 'session-busy' },
      now: 1,
    });
    drain.handleEnqueued('session-busy');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ran).toEqual([]);
    expect(repository.getById('queued-busy')?.status).toBe('queued');
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

  it('startup sweep 只派发无活跃 run 的 session，重复调用不会重复派发', async () => {
    const repository = createRepository();
    repository.enqueue({
      id: 'queued-idle',
      sessionId: 'session-idle',
      envelope: { content: 'dispatch after restart' },
      now: 1,
    });
    repository.enqueue({
      id: 'queued-active',
      sessionId: 'session-active',
      envelope: { content: 'wait for active run' },
      now: 2,
    });
    const runEnvelope = vi.fn().mockResolvedValue(undefined);
    const drain = createDrain({
      repository,
      runEnvelope,
      hasActiveRun: (sessionId) => sessionId === 'session-active',
    });

    drain.runStartupSweep();
    drain.runStartupSweep();

    await vi.waitFor(() => expect(repository.getById('queued-idle')?.status).toBe('consumed'));
    expect(repository.getById('queued-active')?.status).toBe('queued');
    expect(runEnvelope).toHaveBeenCalledTimes(1);
    expect(runEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      clientMessageId: 'queued-idle',
      sessionId: 'session-idle',
    }), expect.anything());
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

  // 2026-07-27 产品负责人实测：队列消息其实发出去了（DB 里 consumed、模型也回复了），
  // 但前端转录区不长东西、卡片不消失、点撤回还被告知「已经开始发送」。
  // 根因是抽干那轮跑在丢弃水槽里且宿主不通知前端，这里把「必须通知」钉死。
  describe('抽干后必须通知前端结算', () => {
    it('消费成功后发出 consumed 通知', async () => {
      const repository = createRepository();
      const settled: QueuedInputSettledEvent[] = [];
      repository.enqueue({ id: 'q1', sessionId: 's1', envelope: { content: '你好' } });

      const drain = createDrain({
        repository,
        settled,
        runEnvelope: async () => {},
      });
      drain.handleReleasedSession('s1');
      await vi.waitFor(() => expect(settled.length).toBe(1));

      expect(settled[0]).toEqual({ sessionId: 's1', id: 'q1', status: 'consumed' });
      expect(repository.getById('q1')?.status).toBe('consumed');
    });

    it('重试耗尽标记失败后同样通知，卡片不会永远留着', async () => {
      const repository = createRepository();
      const settled: QueuedInputSettledEvent[] = [];
      repository.enqueue({ id: 'q2', sessionId: 's2', envelope: { content: '你好' } });

      const drain = createDrain({
        repository,
        settled,
        agentEvents: [],
        runEnvelope: async () => { throw new Error('boom'); },
      });

      // 反复释放直到重试预算耗尽，条目转 failed
      for (let i = 0; i < 10 && repository.getById('q2')?.status !== 'failed'; i += 1) {
        drain.handleReleasedSession('s2');
        await vi.waitFor(() => expect(repository.getById('q2')?.status).not.toBe('sending'));
      }

      expect(repository.getById('q2')?.status).toBe('failed');
      expect(settled.some((event) => event.id === 'q2' && event.status === 'failed')).toBe(true);
    });
  });
});

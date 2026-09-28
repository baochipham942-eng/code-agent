// @vitest-environment jsdom
import express from 'express';
import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpDomainAPI } from '../../../src/renderer/api/httpTransport';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { Message } from '../../../src/shared/contract';
import { registerAgentContinueRoute } from '../../../src/web/routes/registerAgentContinueRoute';

describe('registerAgentContinueRoute', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function start(input: {
    resumeExistingDurableRun: (...args: unknown[]) => Promise<void>;
  }) {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    const source: Message = { id: 'source-1', role: 'user', content: 'finish the task', timestamp: 1, metadata: { retryPrompt: 'finish the task' } };
    const parked = {
      findRecoveredWaitingRun: () => ({ runId: 'run-parked', sessionId: 'session-parked' }),
      getDurableCheckpointState: () => ({ sourceMessageId: source.id }),
      resetDurableResumeBudget: async () => undefined,
      parkDurable: async (...args: unknown[]) => { parked.parkCalls.push(args); },
      parkCalls: [] as unknown[][],
    };
    const taskManager = {
      getSessionState: () => ({ status: 'idle' as const }),
      resumeExistingDurableRun: input.resumeExistingDurableRun,
    };
    registerAgentContinueRoute(router, parked as never, () => taskManager as never, async () => [source]);
    app.use('/api', router);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    return {
      api: createHttpDomainAPI(`http://127.0.0.1:${address.port}`),
      parked,
      source,
    };
  }

  it('continues the owned parked run through the HTTP route and keeps its run id/source message', async () => {
    const calls: unknown[][] = [];
    const { api, source } = await start({
      resumeExistingDurableRun: async (...args) => { calls.push(args); },
    });

    const result = await api.invoke(IPC_DOMAINS.AGENT, 'continue', { sessionId: 'session-parked' });

    expect(result).toEqual({ success: true, data: { runId: 'run-parked' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject([
      'session-parked',
      'run-parked',
      [source],
      { mode: 'normal', disableAutoAgent: true },
      source.metadata,
      source.id,
    ]);
  });

  it('rejects a concurrent second Continue and parks the run back if resume throws', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { api } = await start({
      resumeExistingDurableRun: async () => gate,
    });

    const first = api.invoke(IPC_DOMAINS.AGENT, 'continue', { sessionId: 'session-parked' });
    const second = await api.invoke(IPC_DOMAINS.AGENT, 'continue', { sessionId: 'session-parked' });
    expect(second).toMatchObject({
      success: false,
      error: { code: 'HTTP_409' },
    });
    release();
    await first;

    const failing = await start({
      resumeExistingDurableRun: async () => { throw new Error('resume failed'); },
    });
    await expect(failing.api.invoke(IPC_DOMAINS.AGENT, 'continue', { sessionId: 'session-parked' }))
      .resolves.toMatchObject({ success: false, error: { code: 'HTTP_500' } });
    expect(failing.parked.parkCalls).toHaveLength(1);
    expect(failing.parked.parkCalls[0]).toEqual(['run-parked', { reason: 'user_stop' }]);
  });
});

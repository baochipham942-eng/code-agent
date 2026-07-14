import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';

vi.mock('../../../src/shared/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/shared/constants')>();
  return {
    ...actual,
    CANCELLATION_TIMEOUTS: {
      ...actual.CANCELLATION_TIMEOUTS,
      // Keep unit tests fast while still exercising the settle/timeout branches.
      ROUTE_SETTLE_WAIT: 80,
      ROUTE_SETTLE_POLL: 10,
    },
  };
});

const { registerAgentCancelRoute } = await import('../../../src/web/routes/registerAgentCancelRoute');

describe('registerAgentCancelRoute honest cancel settlement (A3)', () => {
  let server: http.Server | undefined;
  let baseUrl = '';

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function start(registry: RunRegistry) {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerAgentCancelRoute(router, registry);
    app.use('/api', router);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  it('returns Cancelled only after the run leaves the active registry', async () => {
    const registry = new RunRegistry();
    const handle = registry.start({
      runId: 'run-settle',
      sessionId: 'session-settle',
      workspace: '/tmp/native-run-workspace',
    });
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    await handle.attach({
      cancel: async () => {
        await cancelGate;
        registry.unregister(handle.context.runId, handle);
      },
    });
    await start(registry);

    const pending = fetch(`${baseUrl}/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run-settle' }),
    });

    // Still active while cancel is in flight — must not claim Cancelled yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(registry.get('run-settle')).toBeTruthy();

    releaseCancel();
    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Cancelled',
      runId: 'run-settle',
      sessionId: 'session-settle',
    });
    expect(registry.get('run-settle')).toBeUndefined();
  });

  it('returns cancel_requested when settlement times out', async () => {
    const registry = new RunRegistry();
    const handle = registry.start({
      runId: 'run-timeout',
      sessionId: 'session-timeout',
      workspace: '/tmp/native-run-workspace',
    });
    await handle.attach({
      cancel: async () => {
        // Delivered but never settles — registry keeps the run.
      },
    });
    await start(registry);

    const response = await fetch(`${baseUrl}/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-timeout' }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      message: 'cancel_requested',
      code: 'CANCEL_REQUESTED',
      runId: 'run-timeout',
      sessionId: 'session-timeout',
    });
    expect(registry.get('run-timeout')).toBe(handle);
  });

  it('still accepts pre-attach cancel without claiming a settled Cancelled too early', async () => {
    const registry = new RunRegistry();
    registry.start({
      runId: 'run-pre',
      sessionId: 'session-pre',
      workspace: '/tmp/native-run-workspace',
    });
    await start(registry);

    // Cancel before attach: cancel is remembered on the handle, but run stays reserved.
    const response = await fetch(`${baseUrl}/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'run-pre' }),
    });

    // Honest: still reserved after timeout → cancel_requested, not Cancelled.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      message: 'cancel_requested',
      code: 'CANCEL_REQUESTED',
    });
    expect(registry.hasSession('session-pre')).toBe(true);
  });
});

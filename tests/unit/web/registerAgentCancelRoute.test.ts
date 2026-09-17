import express from 'express';
import http from 'http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableRunReadService } from '../../../src/host/app/durableRunReadService';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

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

  async function start(
    registry: RunRegistry,
    readService?: DurableRunReadService,
    onRecoveredWaitingCancelled?: (input: { runId: string; sessionId: string }) => void,
  ) {
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerAgentCancelRoute(router, registry, () => readService, onRecoveredWaitingCancelled);
    app.use('/api', router);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  /** N-DURABLE-WAITING-NO-EXIT 现场：重启恢复成 waiting 的 native run——有 owner 没 handle。 */
  async function recoveredWaitingRegistry(input: { runId: string; sessionId: string }) {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'cancel-route-waiting-')));
    const db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    const kernel = (processInstanceId: string) => new DurableRunKernel({
      stores: repository,
      ownerId: 'route-test',
      processInstanceId,
      leaseDurationMs: 100,
    });
    const first = new RunRegistry();
    first.configureDurableKernel(kernel('before-crash'));
    await first.startDurable({
      runId: input.runId,
      sessionId: input.sessionId,
      workspace,
      cwd: workspace,
    }, 1_000);
    await first.checkpointNativeModelOperation({
      runId: input.runId,
      sourceMessageId: 'message-route',
      provider: 'provider',
      model: 'model',
      logicalOperationId: 'route-turn',
      phase: 'after_model_dispatch',
      status: 'dispatched',
      now: 1_010,
    });
    first.clear();
    const recovered = new RunRegistry();
    recovered.configureDurableKernel(kernel('after-crash'));
    await recovered.recoverDurable(2_000);
    await recovered.checkpointDurable(input.runId, {
      now: 2_000,
      status: 'waiting',
      state: null,
      pendingOperations: [],
      childRuns: [],
      events: [{ type: 'native_recovery_requires_review', payload: { reason: 'fixture' }, recordedAt: 2_000 }],
    });
    return { registry: recovered, db, repository, workspace };
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

  it('does not let a stale durable terminal hide a newer active registry run', async () => {
    const registry = new RunRegistry();
    const handle = registry.start({
      runId: 'run-current',
      sessionId: 'session-reused',
      workspace: '/tmp/native-run-workspace',
    });
    let cancelCount = 0;
    await handle.attach({
      cancel: async () => {
        cancelCount += 1;
        registry.unregister(handle.context.runId, handle);
      },
    });
    const readService = {
      readNativeControl: vi.fn(async () => ({
        source: 'durable',
        consumer: 'native_control',
        runId: 'run-previous',
        sessionId: 'session-reused',
        status: 'completed',
        engine: { kind: 'native' },
        terminal: true,
      })),
    } as unknown as DurableRunReadService;
    await start(registry, readService);

    const response = await fetch(`${baseUrl}/api/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-reused' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      message: 'Cancelled',
      runId: 'run-current',
      sessionId: 'session-reused',
    });
    expect(cancelCount).toBe(1);
    expect(registry.get('run-current')).toBeUndefined();
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

  it('terminalizes a recovered waiting durable run that resolve() cannot see', async () => {
    const { registry, db, repository, workspace } = await recoveredWaitingRegistry({
      runId: 'run-route-waiting',
      sessionId: 'session-route-waiting',
    });
    const cancelledEvents: { runId: string; sessionId: string }[] = [];
    try {
      await start(registry, undefined, (input) => cancelledEvents.push(input));

      const response = await fetch(`${baseUrl}/api/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-route-waiting' }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        message: 'Cancelled',
        runId: 'run-route-waiting',
        sessionId: 'session-route-waiting',
      });
      expect(await repository.get('run-route-waiting')).toMatchObject({
        status: 'cancelled',
        terminal: { status: 'cancelled', reason: 'recovered_waiting_run_cancelled' },
      });
      expect(registry.hasDurableOwner('run-route-waiting')).toBe(false);
      expect(cancelledEvents).toEqual([{ runId: 'run-route-waiting', sessionId: 'session-route-waiting' }]);
    } finally {
      registry.clear();
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps a mismatched runId from touching the session waiting run', async () => {
    const { registry, db, repository, workspace } = await recoveredWaitingRegistry({
      runId: 'run-route-fence',
      sessionId: 'session-route-fence',
    });
    try {
      await start(registry);
      const response = await fetch(`${baseUrl}/api/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'run-someone-else', sessionId: 'session-route-fence' }),
      });

      // runId 对不上：不动那个 waiting run，也不谎报 Cancelled。
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ message: 'No active agent to cancel' });
      expect(await repository.get('run-route-fence')).toMatchObject({ status: 'waiting' });
      expect(registry.hasDurableOwner('run-route-fence')).toBe(true);
    } finally {
      registry.clear();
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

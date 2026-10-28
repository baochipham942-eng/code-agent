import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { createCloudRunLedger, type CloudRunLedger } from '../../../src/host/services/cloudRun/cloudRunLedger';
import { applySchema } from '../../../src/host/services/core/database/schema';
import {
  CloudRunRouteRuntime,
  handleCloudRunAdmission,
  registerCloudRunRoutes,
} from '../../../src/web/routes/cloudRunRoutes';
import type { AgentRunBody } from '../../../src/web/routes/agentBodySchemas';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cloudBody(sessionId: string, clientMessageId: string): AgentRunBody & { protocolVersion: string } {
  return {
    prompt: `work ${clientMessageId}`,
    sessionId,
    clientMessageId,
    protocolVersion: 'environment-selection/1',
    environmentSelection: {
      environmentId: 'cloud-test',
      cwd: '/tmp',
      workspaceRoots: ['/tmp'],
      config: { internet: 'deny', credentialPlaceholders: [] },
    },
  };
}

describe('cloud run HTTP contract', () => {
  let db: BetterSqlite3.Database;
  let ledger: CloudRunLedger;
  let accountId: string | null;
  let server: http.Server;
  let baseUrl: string;
  let runRegistry: RunRegistry;
  let runtime: CloudRunRouteRuntime;
  let started: string[];
  let gates: Map<string, Deferred>;
  let executions: Map<string, ReturnType<RunRegistry['start']>>;

  beforeEach(async () => {
    db = new Database(':memory:');
    applySchema(db, logger);
    accountId = 'acct_a';
    ledger = createCloudRunLedger({ db, accountResolver: () => accountId });
    runRegistry = new RunRegistry();
    started = [];
    gates = new Map();
    executions = new Map();

    const execute = async (body: AgentRunBody, cloudRunId: string): Promise<void> => {
      const handle = runRegistry.start({
        sessionId: body.sessionId!,
        workspace: process.cwd(),
      });
      runtime.bindExecutionRunId(cloudRunId, handle.context.runId);
      executions.set(cloudRunId, handle);
      started.push(body.clientMessageId!);
      const gate = gates.get(body.clientMessageId!) ?? deferred();
      await gate.promise;
      runRegistry.unregister(handle.context.runId, handle);
      executions.delete(cloudRunId);
      runtime.settle(cloudRunId, handle.cancellationRequested ? 'cancelled' : 'succeeded');
    };

    runtime = new CloudRunRouteRuntime({
      getLedger: () => ledger,
      runRegistry,
      execute,
      logger,
    });
    const router = express.Router();
    router.post('/run', async (req, res) => {
      await handleCloudRunAdmission({
        body: req.body,
        res,
        runtime,
        runInline: async (body, cloudRunId) => {
          void execute(body, cloudRunId);
          res.json({ status: 'started' });
        },
      });
    });
    registerCloudRunRoutes(router, { runtime, runRegistry });
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    for (const gate of gates.values()) gate.resolve();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    db.close();
    vi.restoreAllMocks();
  });

  async function postRun(sessionId: string, clientMessageId: string): Promise<Response> {
    gates.set(clientMessageId, deferred());
    return fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cloudBody(sessionId, clientMessageId)),
    });
  }

  it('returns the same persisted queue position from the third POST and GET, then promotes it', async () => {
    await postRun('session_1', 'message_1');
    await postRun('session_2', 'message_2');
    const third = await postRun('session_3', 'message_3');
    const thirdText = await third.text();
    console.log(`RAW third POST /run -> ${third.status} ${thirdText}`);
    expect(third.status).toBe(202);
    const thirdJson = JSON.parse(thirdText);
    expect(thirdJson).toMatchObject({ status: 'queued', queuePosition: 1, ahead: 0 });

    const read = await fetch(`${baseUrl}/api/cloud-runs/${thirdJson.runId}`);
    const readText = await read.text();
    console.log(`RAW GET /cloud-runs/${thirdJson.runId} -> ${read.status} ${readText}`);
    expect(JSON.parse(readText)).toMatchObject({ state: 'queued', queuePosition: 1, ahead: 0 });

    accountId = 'acct_b';
    expect((await fetch(`${baseUrl}/api/cloud-runs/${thirdJson.runId}`)).status).toBe(404);
    accountId = 'acct_a';

    gates.get('message_1')!.resolve();
    await vi.waitFor(() => expect(started).toContain('message_3'));
    expect(ledger.getRun(thirdJson.runId)?.state).toBe('running');
    expect(ledger.countInFlight('acct_a')).toBe(2);
  });

  it('queues a second run on the same session without spending quota', async () => {
    await postRun('session_same', 'message_1');
    const second = await postRun('session_same', 'message_2');
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ queuePosition: 1, ahead: 0 });
    expect(ledger.countInFlight('acct_a')).toBe(1);
  });

  it('requires a verified account for cloud admission', async () => {
    accountId = null;
    const response = await postRun('session_auth', 'message_auth');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'CLOUD_RUN_ACCOUNT_REQUIRED' },
    });
  });

  it('holds the slot through cancel timeout and repeated cancel, then releases exactly once', async () => {
    await postRun('session_cancel', 'message_cancel');
    const cloudRun = ledger.listInFlightRuns()[0];
    const execution = executions.get(cloudRun.runId)!;
    const cancelSpy = vi.spyOn(execution, 'cancel');

    const first = await fetch(`${baseUrl}/api/cloud-runs/${cloudRun.runId}/cancel`, { method: 'POST' });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ code: 'CANCEL_REQUESTED' });
    expect(ledger.countInFlight('acct_a')).toBe(1);
    expect(cancelSpy).toHaveBeenCalledTimes(1);

    // 重复取消不再被 cancel_requested_at 短路：执行体还活着就必须再次真停
    // （幂等重投是 registry 契约），等它真的到达执行体后放行结算。
    const repeated = fetch(`${baseUrl}/api/cloud-runs/${cloudRun.runId}/cancel`, { method: 'POST' });
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledTimes(2));
    gates.get('message_cancel')!.resolve();
    const repeatedResponse = await repeated;
    expect(repeatedResponse.status).toBe(200);
    expect(await repeatedResponse.json()).toMatchObject({ status: 'cancelled' });

    await vi.waitFor(() => expect(ledger.countInFlight('acct_a')).toBe(0));
    expect(ledger.getRun(cloudRun.runId)?.state).toBe('cancelled');
    expect(cancelSpy).toHaveBeenCalledTimes(2);
  }, 25_000);

  it('consumes a pre-bind cancel at bind instead of letting the run finish on its own', async () => {
    // admission 已落 running 行、execution_run_id 尚未绑：POST /run 与 bind 之间的窗口
    const admission = ledger.admit({
      sessionId: 'session_prebind',
      trigger: 'manual',
      requestJson: JSON.stringify(cloudBody('session_prebind', 'message_prebind')),
    });
    expect(admission.record.executionRunId).toBeNull();

    const early = await fetch(`${baseUrl}/api/cloud-runs/${admission.record.runId}/cancel`, { method: 'POST' });
    expect(early.status).toBe(202);
    expect(await early.json()).toMatchObject({ code: 'CANCEL_REQUESTED' });
    expect(ledger.getRun(admission.record.runId)?.cancelRequestedAt).not.toBeNull();

    // 轮次起步：registry 注册 + bind（与 agent.ts 同一顺序）；标记必须在此被消费
    const handle = runRegistry.start({ sessionId: 'session_prebind', workspace: process.cwd() });
    runtime.bindExecutionRunId(admission.record.runId, handle.context.runId);
    await vi.waitFor(() => expect(handle.cancellationRequested).toBe(true));
    expect(ledger.getRun(admission.record.runId)?.state).toBe('running');
  });

  it('a cancel after bind still stops the live run when an earlier pre-bind cancel set the marker', async () => {
    await postRun('session_marker', 'message_marker');
    const cloudRun = ledger.listInFlightRuns()[0];
    // 早期取消只落了标记（bind 前窗口的路由路径等价状态）
    ledger.requestCancel(cloudRun.runId);
    const execution = executions.get(cloudRun.runId)!;
    const cancelSpy = vi.spyOn(execution, 'cancel');

    const response = fetch(`${baseUrl}/api/cloud-runs/${cloudRun.runId}/cancel`, { method: 'POST' });
    await vi.waitFor(() => expect(cancelSpy).toHaveBeenCalledTimes(1));
    gates.get('message_marker')!.resolve();
    const settled = await response;
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({ status: 'cancelled' });
    expect(ledger.getRun(cloudRun.runId)?.state).toBe('cancelled');
  });

  it('marks crashed in-flight rows interrupted and starts the queued head on startup', async () => {
    const first = ledger.admit({
      sessionId: 'session_crashed',
      trigger: 'manual',
      requestJson: JSON.stringify(cloudBody('session_crashed', 'message_crashed')),
    });
    const second = ledger.admit({
      sessionId: 'session_crashed_2',
      trigger: 'manual',
      requestJson: JSON.stringify(cloudBody('session_crashed_2', 'message_crashed_2')),
    });
    const queued = ledger.admit({
      sessionId: 'session_queued',
      trigger: 'manual',
      requestJson: JSON.stringify(cloudBody('session_queued', 'message_queued')),
    });
    gates.set('message_queued', deferred());

    const sweepRuntime = new CloudRunRouteRuntime({
      getLedger: () => ledger,
      runRegistry,
      execute: async (body, cloudRunId) => {
        started.push(body.clientMessageId!);
        const handle = runRegistry.start({ sessionId: body.sessionId!, workspace: process.cwd() });
        ledger.bindExecutionRunId(cloudRunId, handle.context.runId);
      },
      logger,
    });
    await sweepRuntime.runStartupSweep();

    expect(ledger.getRun(first.record.runId)?.state).toBe('interrupted');
    expect(ledger.getRun(second.record.runId)?.state).toBe('interrupted');
    expect(ledger.getRun(queued.record.runId)?.state).toBe('running');
    expect(started).toEqual(['message_queued']);
    expect(ledger.countInFlight('acct_a')).toBe(1);
  });

  it('cancels queued work immediately', async () => {
    await postRun('session_1', 'message_1');
    await postRun('session_2', 'message_2');
    const third = await postRun('session_3', 'message_3');
    const queued = await third.json();

    const cancelled = await fetch(`${baseUrl}/api/cloud-runs/${queued.runId}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });
    expect(ledger.getRun(queued.runId)?.state).toBe('cancelled');
  });
});

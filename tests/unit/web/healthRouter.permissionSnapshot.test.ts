import express from 'express';
import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { createHealthRouter } from '../../../src/web/routes/health';
import {
  broadcastSSE,
  getSSEStreamCursor,
  __resetSSEReplayBufferForTests,
  sseClients,
} from '../../../src/web/helpers/sse';
import { getSessionStateManager } from '../../../src/host/session/sessionStateManager';

let server: http.Server | undefined;

afterEach(async () => {
  sseClients.clear();
  getSessionStateManager().clear();
  __resetSSEReplayBufferForTests();
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
});

function request(): PermissionRequest {
  return {
    id: 'permission-original',
    sessionId: 'session-1',
    type: 'file_write',
    tool: 'Write',
    details: { path: '/tmp/probe.md' },
    timestamp: 100,
  };
}

function createApp() {
  const app = express();
  app.use('/api', createHealthRouter({
    handlers: new Map(),
    getBuildInfo: () => null,
    getPersistenceHealth: () => ({
      status: 'available',
      mode: 'database',
      durable: true,
      message: 'ok',
      checkedAt: 1,
    }),
    getDurableRunReady: () => true,
    getPendingPermissionRequests: () => [],
  }));
  return app;
}

async function startServer(app: express.Express): Promise<number> {
  server = await new Promise<http.Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server port');
  return address.port;
}

async function readSSE(response: globalThis.Response, controller: AbortController): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing SSE response body');
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  controller.abort();
  await reader.cancel().catch(() => undefined);
  return text;
}

function payloads(text: string): Array<{ channel: string; args: Record<string, unknown> }> {
  return text.split('\n\n').flatMap((block) => {
    const match = block.match(/data: ({.*})/);
    if (!match) return [];
    return [JSON.parse(match[1]) as { channel: string; args: Record<string, unknown> }];
  });
}

describe('health SSE pending permission snapshots', () => {
  it('sends the host snapshot on a fresh renderer SSE connection with no Last-Event-ID', async () => {
    const app = express();
    app.use('/api', createHealthRouter({
      handlers: new Map(),
      getBuildInfo: () => null,
      getPersistenceHealth: () => ({
        status: 'available',
        mode: 'database',
        durable: true,
        message: 'ok',
        checkedAt: 1,
      }),
      getDurableRunReady: () => true,
      getPendingPermissionRequests: () => [request()],
    }));
    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server port');

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('missing SSE response body');
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    controller.abort();
    await reader.cancel().catch(() => undefined);

    expect(text).toContain('"channel":"connected"');
    const snapshotBlock = text.split('\n\n').find((block) => block.includes('"type":"permission_request"'));
    expect(snapshotBlock).toBeDefined();
    expect(snapshotBlock).toContain('"channel":"agent:event"');
    expect(snapshotBlock).toContain('"id":"permission-original"');
    expect(snapshotBlock).toContain('"snapshot":true');
    // 快照不进 replay：事件块不能带 SSE 游标行（id:）
    expect(snapshotBlock).not.toContain('id:');
  });

  it('sends status snapshots on a gap and omits a removed session on the next snapshot', async () => {
    const manager = getSessionStateManager();
    manager.updateStatus('session-running', 'running');
    manager.getOrCreate('session-idle');
    for (let i = 0; i < 257; i += 1) {
      broadcastSSE('swarm:event', { seq: i });
    }
    const gapCursor = getSSEStreamCursor();
    const port = await startServer(createApp());

    const firstController = new AbortController();
    const firstResponse = await fetch(
      `http://127.0.0.1:${port}/api/events?lastEventId=0&streamEpoch=${encodeURIComponent(gapCursor.streamEpoch)}`,
      {
        signal: firstController.signal,
      },
    );
    const firstPayloads = payloads(await readSSE(firstResponse, firstController));
    expect(firstPayloads).toContainEqual(expect.objectContaining({
      channel: 'connected',
      args: expect.objectContaining({ requiresSnapshot: true, reason: 'replay_gap' }),
    }));
    const firstStatuses = firstPayloads.filter((payload) => payload.channel === 'session:status:update');
    expect(firstStatuses).toHaveLength(2);
    expect(firstStatuses.map((payload) => payload.args)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'session-running', status: 'running', snapshot: true }),
      expect.objectContaining({ sessionId: 'session-idle', status: 'idle', snapshot: true }),
    ]));

    manager.cleanup('session-idle');
    const secondController = new AbortController();
    const secondResponse = await fetch(`http://127.0.0.1:${port}/api/events`, {
      signal: secondController.signal,
    });
    const secondPayloads = payloads(await readSSE(secondResponse, secondController));
    const secondStatuses = secondPayloads.filter((payload) => payload.channel === 'session:status:update');
    expect(secondStatuses.map((payload) => payload.args.sessionId)).toEqual(['session-running']);
  });

  it('does not send status snapshots for a normal replay without a gap', async () => {
    getSessionStateManager().updateStatus('session-running', 'running');
    broadcastSSE('agent:event', { sessionId: 'session-running', type: 'before-cursor' });
    const cursor = getSSEStreamCursor();
    broadcastSSE('agent:event', { sessionId: 'session-running', type: 'after-cursor' });
    const port = await startServer(createApp());

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/events?lastEventId=${cursor.seq}&streamEpoch=${encodeURIComponent(cursor.streamEpoch)}`,
      { signal: controller.signal },
    );
    const text = await readSSE(response, controller);
    expect(text).toContain('"requiresSnapshot":false');
    expect(text).toContain('"type":"after-cursor"');
    expect(text).not.toContain('"channel":"session:status:update"');
  });
});

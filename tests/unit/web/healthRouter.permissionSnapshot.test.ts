import express from 'express';
import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../../src/shared/contract';
import { createHealthRouter } from '../../../src/web/routes/health';
import { sseClients } from '../../../src/web/helpers/sse';

let server: http.Server | undefined;

afterEach(async () => {
  sseClients.clear();
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
});

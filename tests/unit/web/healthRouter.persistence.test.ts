import express from 'express';
import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHealthRouter } from '../../../src/web/routes/health';
import type { PersistenceHealth, RendererServeDecision, WebHealthResponse } from '../../../src/shared/contract';

let server: http.Server | undefined;
let baseUrl = '';

async function startHealthApi(persistence: PersistenceHealth, rendererServe?: RendererServeDecision) {
  const app = express();
  app.use('/api', createHealthRouter({
    handlers: new Map(),
    getPersistenceHealth: () => persistence,
    getRendererServeDecision: rendererServe ? () => rendererServe : undefined,
  }));

  server = await new Promise<http.Server>((resolve) => {
    const nextServer = app.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function closeServer() {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
  baseUrl = '';
}

afterEach(async () => {
  await closeServer();
});

describe('createHealthRouter persistence health', () => {
  it('includes persistence status in /api/health', async () => {
    const persistence = {
      status: 'unavailable',
      mode: 'memory',
      durable: false,
      message: '历史持久化不可用，当前只会话内有效。',
      reason: 'native binding missing',
      checkedAt: 123,
    } satisfies PersistenceHealth;

    await startHealthApi(persistence);

    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json() as WebHealthResponse;

    expect(response.status).toBe(200);
    expect(body.persistence).toEqual(persistence);
  });

  it('includes renderer serve decision when provided', async () => {
    const persistence = {
      status: 'available',
      mode: 'database',
      durable: true,
      message: 'ok',
      checkedAt: 123,
    } satisfies PersistenceHealth;
    const rendererServe = {
      source: 'builtin',
      reason: 'active-older-than-shell',
      serveDir: '/app/dist/renderer',
      builtinDir: '/app/dist/renderer',
      activeDir: '/data/renderer-cache/active',
      activeBundle: { version: '0.16.101', contentHash: 'abcdef' },
      currentShellVersion: '0.16.102',
    } satisfies RendererServeDecision;

    await startHealthApi(persistence, rendererServe);

    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json() as WebHealthResponse;

    expect(response.status).toBe(200);
    expect(body.rendererServe).toEqual(rendererServe);
  });
});

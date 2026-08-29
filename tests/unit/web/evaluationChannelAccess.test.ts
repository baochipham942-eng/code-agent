import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';

const auth = vi.hoisted(() => ({ admin: false }));

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  assertAdminAccess: (surface: string) => {
    if (!auth.admin) {
      const error = new Error(`${surface}: Admin permission required`) as Error & { code: string };
      error.name = 'AdminAccessError';
      error.code = 'FORBIDDEN';
      throw error;
    }
  },
}));

import { createDomainRouter } from '../../../src/web/routes/domain';

let server: http.Server | undefined;
let baseUrl = '';

async function startApi(handlers: Map<string, WebRouteHandler>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', createDomainRouter({
    handlers,
    logger: { warn: vi.fn(), error: vi.fn() },
  }));
  server = await new Promise<http.Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

beforeEach(() => {
  auth.admin = false;
});

describe('evaluation channel access policy on HTTP transport', () => {
  it('returns HTTP 403 for a non-admin on all three bridge channels before invoking a handler', async () => {
    const handler = vi.fn(async () => ({ runId: 'run-1' }));
    await startApi(new Map([
      ['evaluation:run-suite', handler],
      ['evaluation:run-events', handler],
      ['evaluation:abort-run', handler],
    ]));

    for (const action of ['run-suite', 'run-events', 'abort-run']) {
      const response = await fetch(`${baseUrl}/api/evaluation/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'smoke', maxCases: 1, runId: 'run-1' }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('dispatches the same fallback route for an admin', async () => {
    auth.admin = true;
    const handler = vi.fn(async (_event, payload) => ({ runId: 'run-1', payload }));
    await startApi(new Map([['evaluation:run-suite', handler]]));

    const payload = { scope: 'smoke', maxCases: 1 };
    const response = await fetch(`${baseUrl}/api/evaluation/run-suite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runId: 'run-1', payload });
    expect(handler).toHaveBeenCalledWith(null, payload);
  });
  // 2026-08-29 监工补：dsh v4-pro 变异席抓到 domain.ts 三个查表点（domain / direct / fallback）测试只打了 fallback——
  // 删掉 direct 路由（POST /domain/:domain/:action → `${domain}:${action}`）那处 assertChannelAccess 后整套仍绿，
  // 非 admin 经 /api/domain/evaluation/run-suite 直达 handler。三条 HTTP 进路必须同表同判。
  it('returns HTTP 403 for a non-admin on the direct /domain/:domain/:action route too', async () => {
    const handler = vi.fn(async () => ({ runId: 'run-1' }));
    await startApi(new Map([
      ['evaluation:run-suite', handler],
      ['evaluation:run-events', handler],
      ['evaluation:abort-run', handler],
    ]));

    for (const action of ['run-suite', 'run-events', 'abort-run']) {
      const response = await fetch(`${baseUrl}/api/domain/evaluation/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'smoke', maxCases: 1, runId: 'run-1' }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('dispatches the direct route for an admin', async () => {
    auth.admin = true;
    const handler = vi.fn(async (_event, payload) => ({ runId: 'run-1', payload }));
    await startApi(new Map([['evaluation:run-suite', handler]]));

    const payload = { scope: 'smoke', maxCases: 1 };
    const response = await fetch(`${baseUrl}/api/domain/evaluation/run-suite`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ runId: 'run-1' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainRouter } from '../../../src/web/routes/domain';
import { createSettingsRouter } from '../../../src/web/routes/settings';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';

let server: http.Server | undefined;
let baseUrl = '';

const logger = {
  warn: vi.fn(),
  error: vi.fn(),
};

async function startApi(handlers: Map<string, WebRouteHandler>) {
  const app = express();
  app.use(express.json());
  app.use('/api', createSettingsRouter({ handlers }));
  app.use('/api', createDomainRouter({ handlers, logger }));

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

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await closeServer();
});

describe('settings and domain web routers', () => {
  it('routes settings get and set actions through the domain settings handler', async () => {
    const settingsHandler = vi.fn(async (_event, request) => ({
      ok: true,
      request,
    }));
    await startApi(new Map([['domain:settings', settingsHandler]]));

    const getResponse = await fetch(`${baseUrl}/api/settings`);
    const putResponse = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });

    expect(getResponse.status).toBe(200);
    expect(await readJson(getResponse)).toEqual({
      ok: true,
      request: { action: 'get' },
    });
    expect(putResponse.status).toBe(200);
    expect(await readJson(putResponse)).toEqual({
      ok: true,
      request: { action: 'set', payload: { settings: { theme: 'dark' } } },
    });
    expect(settingsHandler).toHaveBeenNthCalledWith(1, null, { action: 'get', payload: undefined });
    expect(settingsHandler).toHaveBeenNthCalledWith(2, null, {
      action: 'set',
      payload: { settings: { theme: 'dark' } },
    });
  });

  it('reports missing or failed settings handlers with HTTP errors', async () => {
    await startApi(new Map());

    const missing = await fetch(`${baseUrl}/api/settings`);
    expect(missing.status).toBe(501);
    expect(await readJson(missing)).toEqual({ error: 'Settings handler not registered' });

    await closeServer();
    await startApi(new Map([
      ['domain:settings', async () => {
        throw new Error('settings unavailable');
      }],
    ]));

    const failed = await fetch(`${baseUrl}/api/settings`);
    expect(failed.status).toBe(500);
    expect(await readJson(failed)).toEqual({ error: 'settings unavailable' });
  });

  it('routes domain handlers by domain name and preserves payload plus requestId', async () => {
    const sessionHandler = vi.fn(async (_event, request) => ({
      success: true,
      request,
    }));
    await startApi(new Map([['domain:session', sessionHandler]]));

    const response = await fetch(`${baseUrl}/api/domain/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { limit: 2 }, requestId: 'req-1' }),
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      request: {
        action: 'list',
        payload: { limit: 2 },
        requestId: 'req-1',
      },
    });
    expect(sessionHandler).toHaveBeenCalledWith(null, {
      action: 'list',
      payload: { limit: 2 },
      requestId: 'req-1',
    });
  });

  it('uses direct channel handlers and spreads array bodies as positional IPC args', async () => {
    const directHandler = vi.fn(async (_event, first, second) => ({
      first,
      second,
    }));
    await startApi(new Map([['memory:search-code', directHandler]]));

    const response = await fetch(`${baseUrl}/api/memory/search-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(['needle', { limit: 3 }]),
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      first: 'needle',
      second: { limit: 3 },
    });
    expect(directHandler).toHaveBeenCalledWith(null, 'needle', { limit: 3 });
  });

  it('returns structured forbidden and missing-handler responses', async () => {
    const forbidden = Object.assign(new Error('admin only'), { code: 'FORBIDDEN' });
    await startApi(new Map([
      ['domain:admin', async () => {
        throw forbidden;
      }],
    ]));

    const denied = await fetch(`${baseUrl}/api/domain/admin/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { id: 'x' } }),
    });
    expect(denied.status).toBe(200);
    expect(await readJson(denied)).toEqual({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'admin only',
      },
    });

    const missing = await fetch(`${baseUrl}/api/domain/unknown/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'No handler for domain:unknown action:run',
      },
    });
    expect(logger.warn).toHaveBeenCalledWith('No handler for domain: unknown, action: run');
  });
});

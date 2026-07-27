import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest } from '../../../src/shared/ipc';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';

const turnCostRepo = vi.hoisted(() => ({
  getTodayCost: vi.fn(() => ({ usd: 1.25, unknownTurns: 2 })),
  getCostStats: vi.fn(() => [
    { modelId: 'model-a', turns: 3, usd: 0.75, unknownTurns: 1 },
  ]),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getTurnCostRepo: () => turnCostRepo,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const silent = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return {
    ...(await importOriginal<typeof import('../../../src/host/services/infra/logger')>()),
    createLogger: silent,
    logger: silent(),
  };
});

import { registerStatusHandlers } from '../../../src/host/ipc/status.ipc';
import { createDomainRouter } from '../../../src/web/routes/domain';

describe('turn cost status dual transport', () => {
  const handlers = new Map<string, WebRouteHandler>();
  let server: http.Server | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    registerStatusHandlers({
      handle: (channel: string, handler: WebRouteHandler) => handlers.set(channel, handler),
    } as never);
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    server = undefined;
  });

  it('exposes getTodayCost through native IPC and the shared web domain route', async () => {
    const handler = handlers.get(IPC_DOMAINS.STATUS)!;
    const request: IPCRequest = {
      action: 'getTodayCost',
      requestId: 'status-1',
    };
    const nativeResult = await handler(null, request);

    const app = express();
    app.use(express.json());
    app.use('/api', createDomainRouter({
      handlers,
      logger: { warn: vi.fn(), error: vi.fn() },
    }));
    server = await new Promise<http.Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected test server address');
    }
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/domain/status/getTodayCost`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: request.requestId }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(nativeResult);
    expect(nativeResult).toEqual({
      success: true,
      data: { usd: 1.25, unknownTurns: 2 },
    });
  });

  it('validates days and returns model aggregates', async () => {
    const handler = handlers.get(IPC_DOMAINS.STATUS)!;
    await expect(handler(null, {
      action: 'getCostStats',
      payload: { days: 14 },
    })).resolves.toEqual({
      success: true,
      data: [{ modelId: 'model-a', turns: 3, usd: 0.75, unknownTurns: 1 }],
    });
    expect(turnCostRepo.getCostStats).toHaveBeenCalledWith(14);

    await expect(handler(null, {
      action: 'getCostStats',
      payload: { days: 0 },
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGS' },
    });
  });
});

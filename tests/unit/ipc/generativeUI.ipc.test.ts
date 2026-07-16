import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { IPCRequest } from '../../../src/shared/ipc';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';

const service = vi.hoisted(() => ({
  isEnabled: vi.fn(() => true),
  isManifestEnabled: vi.fn(() => true),
  resolveInstance: vi.fn((payload: unknown) => ({ enabled: true, payload })),
  applyEvent: vi.fn((event: unknown) => ({ status: 'applied', event })),
  resolveManifest: vi.fn((payload: unknown) => ({ accepted: true, payload })),
}));

vi.mock('../../../src/host/services/generativeUI/generativeUIService', () => ({
  getGenerativeUIService: () => service,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { registerGenerativeUIHandlers } from '../../../src/host/ipc/generativeUI.ipc';
import { createDomainRouter } from '../../../src/web/routes/domain';

describe('Generative UI dual transport', () => {
  const handlers = new Map<string, WebRouteHandler>();
  let server: http.Server | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    registerGenerativeUIHandlers({
      handle: (channel: string, handler: WebRouteHandler) => handlers.set(channel, handler),
    } as never);
  });

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  });

  it('returns the same domain result through Native IPC and the HTTP Domain Router', async () => {
    const handler = handlers.get(IPC_DOMAINS.GENERATIVE_UI)!;
    const request: IPCRequest = {
      action: 'resolveInstance',
      requestId: 'request-1',
      payload: {
        sessionId: 's1',
        sourceMessageId: 'm1',
        sourceOrdinal: 0,
        rawSpec: '{}',
      },
    };
    const nativeResult = await handler(null, request);

    const app = express();
    app.use(express.json());
    app.use('/api', createDomainRouter({ handlers, logger: { warn: vi.fn(), error: vi.fn() } }));
    server = await new Promise<http.Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected test server address');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/domain/generativeUI/resolveInstance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: request.payload, requestId: request.requestId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(nativeResult);
    expect(service.resolveInstance).toHaveBeenCalledTimes(2);
  });

  it('fails closed on malformed actions before calling the service', async () => {
    const handler = handlers.get(IPC_DOMAINS.GENERATIVE_UI)!;
    await expect(handler(null, { action: 'resolveManifest', payload: { decision: 'approve' } }))
      .resolves.toEqual({
        success: false,
        error: { code: 'INVALID_ARGS', message: 'sessionId, manifestId and nonce are required' },
      });
    expect(service.resolveManifest).not.toHaveBeenCalled();
  });
});

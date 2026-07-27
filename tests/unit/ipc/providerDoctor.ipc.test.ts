import express from 'express';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest } from '../../../src/shared/ipc';
import type { DoctorReport } from '../../../src/host/diagnostics/types';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';

const runDoctorMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/diagnostics/doctorRunner', () => ({
  runDoctor: runDoctorMock,
}));

import { registerProviderHandlers } from '../../../src/host/ipc/provider.ipc';
import { createDomainRouter } from '../../../src/web/routes/domain';

const REPORT_WITH_FAILED_ITEM: DoctorReport = {
  timestamp: 100,
  durationMs: 25,
  items: [
    {
      category: 'mcp',
      name: 'broken-server',
      status: 'fail',
      message: '检查抛错',
      details: 'spawn failed',
      fix: { code: 'open-mcp-settings' },
    },
  ],
  summary: { pass: 0, warn: 0, fail: 1, skip: 0 },
};

describe('Provider Doctor dual-transport contract', () => {
  const handlers = new Map<string, WebRouteHandler>();
  let server: http.Server | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    runDoctorMock.mockResolvedValue(REPORT_WITH_FAILED_ITEM);
    registerProviderHandlers({
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

  it('returns the same complete report through Native IPC and the HTTP domain route', async () => {
    const handler = handlers.get(IPC_DOMAINS.PROVIDER);
    if (!handler) throw new Error('Provider handler was not registered');
    const request: IPCRequest = {
      action: 'run_doctor',
      requestId: 'doctor-request-1',
      payload: {
        category: 'mcp',
        skipNetwork: true,
        perCheckTimeoutMs: 1_000,
        overallTimeoutMs: 5_000,
      },
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
    if (!address || typeof address === 'string') throw new Error('Expected test server address');

    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/domain/provider/run_doctor`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: request.payload, requestId: request.requestId }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(nativeResult);
    expect(nativeResult).toEqual({ success: true, data: REPORT_WITH_FAILED_ITEM });
    expect(runDoctorMock).toHaveBeenNthCalledWith(1, request.payload);
    expect(runDoctorMock).toHaveBeenNthCalledWith(2, request.payload);
  });

  it.each([
    [{ category: 'unknown' }, /category must be one of/],
    [{ skipNetwork: 'yes' }, /skipNetwork must be a boolean/],
    [{ perCheckTimeoutMs: 0 }, /perCheckTimeoutMs must be an integer/],
    [{ overallTimeoutMs: 999_999 }, /overallTimeoutMs must be an integer/],
    [{ extra: true }, /Unknown run_doctor option/],
  ])('rejects malformed payload %# before running Doctor', async (payload, message) => {
    const handler = handlers.get(IPC_DOMAINS.PROVIDER);
    if (!handler) throw new Error('Provider handler was not registered');

    await expect(handler(null, { action: 'run_doctor', payload })).resolves.toEqual({
      success: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message: expect.stringMatching(message),
      },
    });
    expect(runDoctorMock).not.toHaveBeenCalled();
  });
});

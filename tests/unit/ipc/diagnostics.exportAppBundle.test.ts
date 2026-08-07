import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const bundleState = vi.hoisted(() => ({
  calls: [] as Array<{ doctorReport?: unknown }>,
}));

vi.mock('../../../src/host/diagnostics/appDiagnosticsBundleBuilder', () => ({
  buildAppDiagnosticsBundle: async (options: { doctorReport?: unknown }) => {
    bundleState.calls.push(options);
    return {
      buffer: Buffer.from('zip-bytes'),
      suggestedFileName: 'neo-diagnostics-20260807-120000.zip',
      manifest: { schemaVersion: 1, generatedAt: 0, appVersion: '0.0.0', windowDays: 7, includes: {}, files: [] },
    };
  },
}));

import { registerDiagnosticsHandlers } from '../../../src/host/ipc/diagnostics.ipc';

type DiagnosticsHandler = (e: unknown, req: IPCRequest) => Promise<IPCResponse>;

function captureHandler(): DiagnosticsHandler {
  const handlers = new Map<string, DiagnosticsHandler>();
  const fakeIpcMain = {
    handle: (domain: string, fn: DiagnosticsHandler) => {
      handlers.set(domain, fn);
    },
  };
  registerDiagnosticsHandlers(fakeIpcMain as never);
  const handler = handlers.get(IPC_DOMAINS.DIAGNOSTICS);
  if (!handler) throw new Error('diagnostics handler not registered');
  return handler;
}

beforeEach(() => {
  bundleState.calls = [];
});

describe('diagnostics exportAppBundle', () => {
  it('returns a base64-encoded zip with the suggested file name', async () => {
    const res = await captureHandler()(null, { action: 'exportAppBundle', payload: {} } as IPCRequest);

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      content: Buffer.from('zip-bytes').toString('base64'),
      suggestedFileName: 'neo-diagnostics-20260807-120000.zip',
      encoding: 'base64',
    });
  });

  it('forwards the renderer-provided doctor report through to the bundle builder', async () => {
    const doctorReport = { summary: { pass: 1, warn: 0, fail: 0, skip: 0 } };
    await captureHandler()(null, { action: 'exportAppBundle', payload: { doctorReport } } as IPCRequest);

    expect(bundleState.calls).toHaveLength(1);
    expect(bundleState.calls[0].doctorReport).toEqual(doctorReport);
  });

  it('works without a payload (doctorReport optional)', async () => {
    const res = await captureHandler()(null, { action: 'exportAppBundle' } as IPCRequest);

    expect(res.success).toBe(true);
    expect(bundleState.calls[0].doctorReport).toBeUndefined();
  });
});

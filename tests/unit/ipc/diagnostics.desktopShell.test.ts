import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopShellDiagnostics } from '../../../src/shared/contract';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const diagnosticsState = vi.hoisted(() => ({
  calls: 0,
  diagnostics: {
    schemaVersion: 1,
    generatedAt: '2026-06-24T00:00:00.000Z',
    app: {
      version: '0.16.102',
      mode: 'tauri',
      dataDir: '/Users/x/.code-agent',
      webPort: 8180,
      pid: 100,
    },
    boot: {
      stage: 'health-ready',
      bootId: 'boot-hash',
      pid: 100,
      webServerPid: 200,
      healthMatchedBootToken: true,
      diagnosticFile: '/Users/x/.code-agent/logs/desktop-shell-boot-latest.json',
    },
    webServer: {
      url: 'http://localhost:8180',
      health: 'ok',
      pid: 200,
    },
    renderer: {
      source: 'builtin',
      reason: 'no-active-meta',
      serveDir: '/app/dist/renderer',
      builtinDir: '/app/dist/renderer',
      activeBundle: null,
    },
    resources: [],
    runtimeAssets: null,
    rendererBundle: null,
    issues: [],
  } as DesktopShellDiagnostics,
}));

vi.mock('../../../src/main/diagnostics/desktopShellDiagnostics', () => ({
  getDesktopShellDiagnostics: async () => {
    diagnosticsState.calls += 1;
    return diagnosticsState.diagnostics;
  },
}));

import { registerDiagnosticsHandlers } from '../../../src/main/ipc/diagnostics.ipc';

function captureHandler() {
  let handler: ((e: unknown, req: IPCRequest) => Promise<IPCResponse>) | null = null;
  const fakeIpcMain = {
    handle: (domain: string, fn: (e: unknown, req: IPCRequest) => Promise<IPCResponse>) => {
      if (domain === IPC_DOMAINS.DIAGNOSTICS) handler = fn;
    },
  };
  registerDiagnosticsHandlers(fakeIpcMain as never);
  if (!handler) throw new Error('diagnostics handler not registered');
  return handler;
}

beforeEach(() => {
  diagnosticsState.calls = 0;
});

describe('diagnostics desktopShell', () => {
  it('returns the aggregated desktop shell diagnostics without raw boot token', async () => {
    const res = await captureHandler()(null, { action: 'desktopShell' } as IPCRequest);

    expect(res.success).toBe(true);
    expect(diagnosticsState.calls).toBe(1);
    expect(res.data).toMatchObject({
      schemaVersion: 1,
      boot: {
        stage: 'health-ready',
        bootId: 'boot-hash',
        healthMatchedBootToken: true,
      },
      webServer: { health: 'ok' },
      renderer: { source: 'builtin', reason: 'no-active-meta' },
    });
    expect(JSON.stringify(res.data)).not.toContain('tauri-');
  });
});

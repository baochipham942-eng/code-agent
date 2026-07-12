import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RendererServeDecision, RuntimeAssetsStatus } from '../../../src/shared/contract';

const state = vi.hoisted(() => ({
  userData: '',
  version: '0.16.102',
  runtimeAssets: {
    runtimeBaseDir: '/runtime',
    activeManifestPath: '/runtime/active.json',
    assets: [],
    summary: { installed: 1, bundledFallback: 1, missing: 0, unsupported: 0 },
  } as RuntimeAssetsStatus,
}));

vi.mock('../../../src/host/platform', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? state.userData : os.tmpdir()),
    getVersion: () => state.version,
  },
}));

vi.mock('../../../src/host/runtime/runtimeAssetStatus', () => ({
  getRuntimeAssetsStatus: async () => state.runtimeAssets,
}));

vi.mock('../../../src/host/services/renderer/rendererBundleCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/renderer/rendererBundleCache')>();
  return {
    ...actual,
    readRendererBundleStatus: () => ({
      schemaVersion: 1,
      activeBundle: null,
      lastAttempt: null,
    }),
  };
});

import {
  getDesktopShellDiagnostics,
  getDesktopShellResourceChecks,
} from '../../../src/host/diagnostics/desktopShellDiagnostics';

describe('desktop shell diagnostics aggregator', () => {
  let root: string;
  let originalFetch: typeof globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-shell-diag-'));
    state.userData = path.join(root, 'user-data');
    fs.mkdirSync(path.join(state.userData, 'logs'), { recursive: true });
    originalFetch = globalThis.fetch;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeFile(filePath: string, content = 'x') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  it('checks critical packaged resources without hashing the bundle', () => {
    const resourceRoot = path.join(root, '_up_');
    writeFile(path.join(resourceRoot, 'dist', 'web', 'webServer.cjs'));
    writeFile(path.join(resourceRoot, 'dist', 'renderer', 'index.html'));
    const nodePath = path.join(resourceRoot, 'dist', 'bundled-node', 'bin', 'node');
    writeFile(nodePath, '#!/usr/bin/env node\n');
    fs.chmodSync(nodePath, 0o755);
    writeFile(path.join(
      resourceRoot,
      'dist',
      'native',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    ));

    const checks = getDesktopShellResourceChecks({ resourceRoot });

    expect(checks.filter((check) => check.required).every((check) => check.status === 'present')).toBe(true);
    expect(checks).toContainEqual(expect.objectContaining({
      id: 'control-plane-public-keys',
      required: false,
      status: 'missing',
    }));
  });

  it('treats the critical sqlite native module as a required resource', async () => {
    const resourceRoot = path.join(root, '_up_');
    writeFile(path.join(resourceRoot, 'dist', 'web', 'webServer.cjs'));
    writeFile(path.join(resourceRoot, 'dist', 'renderer', 'index.html'));
    const nodePath = path.join(resourceRoot, 'dist', 'bundled-node', 'bin', 'node');
    writeFile(nodePath, '#!/usr/bin/env node\n');
    fs.chmodSync(nodePath, 0o755);
    process.env.AGENT_NEO_BUNDLED_RUNTIME_ROOT = resourceRoot;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      mode: 'web-standalone',
      timestamp: 1,
      handlers: 10,
      serverRoot: resourceRoot,
      pid: 200,
      persistence: {
        status: 'available',
        mode: 'database',
        durable: true,
        message: 'ok',
        checkedAt: 1,
      },
    }), { status: 200 })) as unknown as typeof fetch;

    const diagnostics = await getDesktopShellDiagnostics();

    expect(diagnostics.resources).toContainEqual(expect.objectContaining({
      id: 'better-sqlite3-native',
      required: true,
      status: 'missing',
    }));
    expect(diagnostics.issues).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'desktop-shell-required-resource-missing',
    }));
  });

  it('aggregates boot file, web health, renderer serve decision, runtime assets, and resource issues', async () => {
    const rendererServe = {
      source: 'active',
      reason: 'active-healthy',
      serveDir: '/data/renderer-cache/active',
      builtinDir: '/app/dist/renderer',
      activeDir: '/data/renderer-cache/active',
      activeBundle: { version: '0.16.103', contentHash: 'abcdef1234567890' },
      currentShellVersion: '0.16.103',
    } satisfies RendererServeDecision;
    fs.writeFileSync(
      path.join(state.userData, 'logs', 'desktop-shell-boot-latest.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-06-24T00:00:00.000Z',
        pid: 100,
        webPort: 8180,
        stage: 'health-ready',
        bootId: 'boot-hash',
        webServerPid: 200,
        healthMatchedBootToken: true,
        previousFailure: {
          stage: 'web-server-spawned',
          recordedStage: 'failed',
          generatedAt: '2026-06-23T23:59:00.000Z',
          code: 'desktop-shell-healthcheck-failed',
          message: 'healthcheck timed out',
          diagnosticFile: '/app/logs/desktop-shell-boot-latest.json',
          webPort: 8180,
          webServerPid: 199,
        },
        resources: [{
          id: 'web-server-script',
          label: 'webServer bundle',
          kind: 'web-server',
          path: '/app/dist/web/webServer.cjs',
          required: true,
          status: 'present',
        }, {
          id: 'control-plane-public-keys',
          label: 'control-plane public keys',
          kind: 'resource',
          path: '/app/dist/web/control-plane-public-keys.json',
          required: false,
          status: 'missing',
          message: 'resource missing from packaged bundle',
        }],
      }),
      'utf8',
    );
    process.env.CODE_AGENT_TAURI_BOOT_TOKEN = 'tauri-secret-token';
    process.env.CODE_AGENT_BUNDLE_ID = 'com.linchen.code-agent';
    process.env.CODE_AGENT_WEB_PORT = '8180';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      mode: 'web-standalone',
      timestamp: 1,
      handlers: 10,
      serverRoot: '/app',
      pid: 200,
      tauriBootToken: 'tauri-secret-token',
      persistence: {
        status: 'available',
        mode: 'database',
        durable: true,
        message: 'ok',
        checkedAt: 1,
      },
      rendererServe,
    }), { status: 200 })) as unknown as typeof fetch;

    const diagnostics = await getDesktopShellDiagnostics();

    expect(diagnostics).toMatchObject({
      schemaVersion: 1,
      app: {
        version: '0.16.102',
        mode: 'tauri',
        bundleId: 'com.linchen.code-agent',
        webPort: 8180,
        channel: 'prod',
      },
      boot: {
        stage: 'health-ready',
        bootId: 'boot-hash',
        webServerPid: 200,
        healthMatchedBootToken: true,
      },
      webServer: {
        health: 'ok',
        pid: 200,
      },
      renderer: rendererServe,
      runtimeAssets: state.runtimeAssets,
      channelIsolation: {
        channel: 'prod',
        status: 'ok',
        webPort: 8180,
        expectedWebPort: 8180,
      },
    });
    expect(diagnostics.boot.previousFailure).toMatchObject({
      stage: 'web-server-spawned',
      code: 'desktop-shell-healthcheck-failed',
    });
    expect(diagnostics.issues).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'desktop-shell-previous-launch-failed',
    }));
    expect(diagnostics.repairActions?.map((action) => action.kind)).toEqual(expect.arrayContaining([
      'inspect-boot-diagnostics',
      'clear-webserver-port',
      'disable-hot-renderer',
      'rebuild-renderer-cache',
    ]));
    expect(diagnostics.issues).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'desktop-shell-optional-resource-missing',
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('tauri-secret-token');
  });

  it('reports packaged dev channel isolation separately from production', async () => {
    state.userData = path.join(root, '.code-agent-dev');
    fs.mkdirSync(path.join(state.userData, 'logs'), { recursive: true });
    process.env.CODE_AGENT_BUNDLE_ID = 'com.linchen.code-agent.dev';
    process.env.CODE_AGENT_WEB_PORT = '8181';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      mode: 'web-standalone',
      timestamp: 1,
      handlers: 10,
      serverRoot: '/app',
      pid: 201,
      persistence: {
        status: 'available',
        mode: 'database',
        durable: true,
        message: 'ok',
        checkedAt: 1,
      },
    }), { status: 200 })) as unknown as typeof fetch;

    const diagnostics = await getDesktopShellDiagnostics();

    expect(diagnostics.app).toMatchObject({
      bundleId: 'com.linchen.code-agent.dev',
      webPort: 8181,
      channel: 'dev',
    });
    expect(diagnostics.channelIsolation).toMatchObject({
      channel: 'dev',
      status: 'ok',
      bundleId: 'com.linchen.code-agent.dev',
      dataDir: state.userData,
      webPort: 8181,
      expectedWebPort: 8181,
    });
    expect(diagnostics.channelIsolation?.checks.every((check) => check.status === 'ok')).toBe(true);
  });

  it('reads Tauri boot diagnostics from the explicit packaged app data path', async () => {
    const tauriDataDir = path.join(root, 'tauri-app-data');
    const bootFile = path.join(tauriDataDir, 'logs', 'desktop-shell-boot-latest.json');
    writeFile(bootFile, JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-06-24T00:00:00.000Z',
      pid: 300,
      webPort: 19191,
      stage: 'window-navigated',
      bootId: 'tauri-boot',
      webServerPid: 301,
      healthMatchedBootToken: true,
      diagnosticFile: bootFile,
      resources: [],
    }));
    process.env.AGENT_NEO_TAURI_BOOT_DIAGNOSTICS_FILE = bootFile;
    process.env.CODE_AGENT_WEB_PORT = '19191';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      mode: 'web-standalone',
      timestamp: 1,
      handlers: 10,
      serverRoot: '/app',
      pid: 301,
      persistence: {
        status: 'available',
        mode: 'database',
        durable: true,
        message: 'ok',
        checkedAt: 1,
      },
      rendererServe: {
        source: 'builtin',
        reason: 'no-active-meta',
        serveDir: '/app/dist/renderer',
        builtinDir: '/app/dist/renderer',
        activeBundle: null,
        currentShellVersion: '0.16.102',
      },
    }), { status: 200 })) as unknown as typeof fetch;

    const diagnostics = await getDesktopShellDiagnostics();

    expect(diagnostics.boot).toMatchObject({
      stage: 'window-navigated',
      bootId: 'tauri-boot',
      webServerPid: 301,
      diagnosticFile: bootFile,
    });
    expect(diagnostics.app.dataDir).toBe(state.userData);
  });
});

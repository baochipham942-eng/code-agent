import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type CreateAppDeps } from '../../../src/web/app';
import { SERVER_AUTH_TOKEN } from '../../../src/web/middleware/auth';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import type { BuildInfo } from '../../../src/shared/contract';

function buildDeps(dataDir: string): CreateAppDeps {
  const build = {
    appName: 'Agent Neo Dev',
    branch: 'mq/health-safe-projection',
    commit: '1234567890123456789012345678901234567890',
    commitShort: '1234567',
    dirty: false,
    worktree: dataDir,
    builtAt: '2026-10-06T00:00:00.000Z',
    version: '0.0.0-test',
  } as BuildInfo & { version: string };
  return {
    handlers: new Map(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runRegistry: new RunRegistry(),
    pendingLocalToolCalls: new Map(),
    pendingDevPermissions: new Map(),
    resolveCodeAgentDataDir: () => dataDir,
    getAppVersion: () => '0.0.0-test',
    getBuildInfo: () => build,
    getDurableRunRollout: () => ({
      policy: {
        mode: 'legacy',
        configuredValue: null,
        valid: true,
        durableActivation: false,
        durableReadPreference: false,
      },
      ready: false,
    }),
    getDurableRunReadService: () => undefined,
    internalFeatures: {
      runtime: { isLoaded: () => false, loadedHash: () => undefined },
      registry: { getPlugin: () => undefined },
      pluginsDir: `${dataDir}/plugins`,
    },
  };
}

describe('health public projection and authenticated detail route', () => {
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = http.createServer(createApp(buildDeps('/tmp/health-safe-projection')));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('keeps unauthenticated /health to its public liveness projection', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      'build',
      'durableRunReady',
      'mode',
      'rendererServe',
      'status',
      'tauriBootToken',
      'timestamp',
    ].sort());
    expect(body).toMatchObject({
      status: 'ok',
      mode: 'web-standalone',
      build: { version: '0.0.0-test' },
    });
    expect(body).not.toHaveProperty('serverRoot');
    expect(body).not.toHaveProperty('pid');
    expect(body).not.toHaveProperty('handlers');
    expect(body).not.toHaveProperty('persistence');
  });

  it('requires auth for the full health detail route and returns the full payload with a token', async () => {
    const missing = await fetch(`${baseUrl}/api/health/detail`);
    expect(missing.status).toBe(401);

    const response = await fetch(`${baseUrl}/api/health/detail`, {
      headers: { Authorization: `Bearer ${SERVER_AUTH_TOKEN}` },
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      mode: 'web-standalone',
      build: expect.objectContaining({ version: '0.0.0-test' }),
    });
    expect(body).toHaveProperty('serverRoot');
    expect(body).toHaveProperty('pid');
    expect(body).toHaveProperty('handlers');
    expect(body).toHaveProperty('persistence');
  });
});

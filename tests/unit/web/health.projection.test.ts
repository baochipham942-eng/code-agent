import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

  afterEach(() => vi.unstubAllEnvs());

  it('keeps unauthenticated /health to its public liveness projection', async () => {
    const token = 'boot-1';
    vi.stubEnv('CODE_AGENT_TAURI_BOOT_TOKEN', token);
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual([
      'build',
      'durableRunReady',
      'mode',
      'rendererServe',
      'status',
      'timestamp',
    ].sort());
    expect(body).toMatchObject({
      status: 'ok',
      mode: 'web-standalone',
      build: { version: '0.0.0-test' },
    });
    expect(body).not.toHaveProperty('tauriBootToken');
    expect(body).not.toHaveProperty('bootProof');
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain('boot-');
    expect(JSON.stringify(body)).not.toContain(createHash('sha256').update(token).digest('hex'));
    expect(body).not.toHaveProperty('serverRoot');
    expect(body).not.toHaveProperty('pid');
    expect(body).not.toHaveProperty('handlers');
    expect(body).not.toHaveProperty('persistence');
  });

  it('returns a nonce-bound HMAC proof, never a raw token echo', async () => {
    vi.stubEnv('CODE_AGENT_TAURI_BOOT_TOKEN', 'boot-1');
    const nonce = 'a'.repeat(64);
    const response = await fetch(`${baseUrl}/api/health?bootChallenge=${nonce}`);
    const body = await response.json() as Record<string, unknown>;
    // Shared known-answer vector with Rust: UTF-8 key and nonce, lowercase hex output.
    const expected = '2af975b031f020c4f00b0829926ff168ad4b92538516dce0ab56b0669a5a47ea';
    expect(body.bootProof === expected).toBe(true);
    expect(body).not.toHaveProperty('tauriBootToken');
    expect(JSON.stringify(body)).not.toContain('boot-1');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const nextNonce = 'b'.repeat(64);
    const next = await fetch(`${baseUrl}/api/health?bootChallenge=${nextNonce}`);
    const nextBody = await next.json() as Record<string, unknown>;
    expect(nextBody.bootProof === createHmac('sha256', 'boot-1').update(nextNonce).digest('hex')).toBe(true);
    expect(nextBody.bootProof === body.bootProof).toBe(false);
  });

  it('omits proof without a boot token', async () => {
    vi.stubEnv('CODE_AGENT_TAURI_BOOT_TOKEN', undefined);
    const response = await fetch(`${baseUrl}/api/health?bootChallenge=${'a'.repeat(64)}`);
    expect(await response.json()).not.toHaveProperty('bootProof');
  });

  it.each([
    '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64),
    `${'a'.repeat(63)}%0A`, `${'a'.repeat(64)}&bootChallenge=${'b'.repeat(64)}`,
    `${'a'.repeat(63)}%2F`,
  ])('omits proof for invalid challenge shape: %s', async (nonce) => {
    vi.stubEnv('CODE_AGENT_TAURI_BOOT_TOKEN', 'boot-1');
    const response = await fetch(`${baseUrl}/api/health?bootChallenge=${nonce}`);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('bootProof');
  });

  it('requires auth for the full health detail route and returns the full payload with a token', async () => {
    vi.stubEnv('CODE_AGENT_TAURI_BOOT_TOKEN', 'boot-1');
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
    expect(body).toHaveProperty('tauriBootConfigured', true);
    expect(body).not.toHaveProperty('tauriBootToken');
    expect(body).not.toHaveProperty('bootProof');
    expect(body).toHaveProperty('serverRoot');
    expect(body).toHaveProperty('pid');
    expect(body).toHaveProperty('handlers');
    expect(body).toHaveProperty('persistence');
  });
});

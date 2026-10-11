import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createApp, type CreateAppDeps } from '../../../src/web/app';
import { SERVER_AUTH_TOKEN } from '../../../src/web/middleware/auth';
import { createQuitGuardRouter } from '../../../src/web/routes/quitGuard';
import {
  getApplicationRunRegistry,
  resetApplicationRunRegistryForTests,
} from '../../../src/host/app/applicationRunRegistry';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import * as cronModule from '../../../src/host/cron/cronService';

const HEALTH_KEYS = [
  'status',
  'mode',
  'timestamp',
  'durableRunReady',
  'rendererServe',
  'tauriBootToken',
  'build',
];

function buildDeps(dataDir: string): CreateAppDeps {
  const runRegistry = new RunRegistry();
  runRegistry.start({
    runId: 'injected-quit-guard-run',
    sessionId: 'injected-quit-guard-session',
    workspace: process.cwd(),
  });
  return {
    handlers: new Map(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runRegistry,
    pendingLocalToolCalls: new Map(),
    pendingDevPermissions: new Map(),
    resolveCodeAgentDataDir: () => dataDir,
    getAppVersion: () => '0.0.0-test',
    getBuildInfo: () => null,
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

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function installCronJobs(jobs: Array<{ enabled: boolean }>): ReturnType<typeof vi.fn> {
  const listJobs = vi.fn((filter?: { enabled?: boolean }) => {
    if (filter?.enabled === undefined) return jobs;
    return jobs.filter((job) => job.enabled === filter.enabled);
  });
  vi.spyOn(cronModule, 'getCronService').mockReturnValue({
    listJobs,
  } as unknown as ReturnType<typeof cronModule.getCronService>);
  return listJobs;
}

describe('createQuitGuardRouter', () => {
  it('returns the arranged activeRuns and armedSchedules and no other keys', async () => {
    const app = express();
    app.use('/api', createQuitGuardRouter({
      getSnapshot: async () => ({
        activeRuns: 4,
        armedSchedules: 7,
        pid: 99,
        serverRoot: '/tmp/hidden',
      } as { activeRuns: number; armedSchedules: number }),
    }));
    const server = http.createServer(app);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/quit-guard`);
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(body).toEqual({ activeRuns: 4, armedSchedules: 7 });
      expect(Object.keys(body)).toEqual(['activeRuns', 'armedSchedules']);
    } finally {
      await close(server);
    }
  });

  it('returns 500 and no numeric fields when the snapshot source throws', async () => {
    const app = express();
    app.use('/api', createQuitGuardRouter({
      getSnapshot: async () => {
        throw new Error('snapshot down');
      },
    }));
    const server = http.createServer(app);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/quit-guard`);
      const text = await response.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(response.status).toBe(500);
      expect(body).toEqual({ error: 'quit-guard-unavailable' });
      expect(text).not.toContain('activeRuns');
      expect(text).not.toContain('armedSchedules');
      expect(Object.values(body).some((value) => typeof value === 'number')).toBe(false);
    } finally {
      await close(server);
    }
  });

  it('returns 500 and no partial counts when a snapshot field is not an integer', async () => {
    const app = express();
    app.use('/api', createQuitGuardRouter({
      getSnapshot: async () => ({
        activeRuns: 1,
        armedSchedules: 1.5,
      } as { activeRuns: number; armedSchedules: number }),
    }));
    const server = http.createServer(app);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/quit-guard`);
      const body = await response.json() as Record<string, unknown>;
      expect(response.status).toBe(500);
      expect(body).toEqual({ error: 'quit-guard-unavailable' });
      expect(body.activeRuns).toBeUndefined();
      expect(body.armedSchedules).toBeUndefined();
    } finally {
      await close(server);
    }
  });
});

describe('GET /api/quit-guard on createApp', () => {
  let server: http.Server;
  let baseUrl = '';
  let listJobs: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    resetApplicationRunRegistryForTests();
    const app = createApp(buildDeps('/tmp/quit-guard-route'));
    server = http.createServer(app);
    baseUrl = await listen(server);
  });

  beforeEach(() => {
    resetApplicationRunRegistryForTests();
    listJobs = installCronJobs([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetApplicationRunRegistryForTests();
  });

  afterAll(async () => {
    await close(server);
    resetApplicationRunRegistryForTests();
  });

  async function getQuitGuard(authorization?: string): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {};
    if (authorization !== undefined) headers.Authorization = authorization;
    const response = await fetch(`${baseUrl}/api/quit-guard`, { headers });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  it('refuses GET /api/quit-guard without a token and with a wrong token, and neither body contains counts', async () => {
    const missing = await getQuitGuard();
    expect(missing.status).toBe(401);
    expect(missing.text).not.toContain('activeRuns');
    expect(missing.text).not.toContain('armedSchedules');
    expect(missing.body.activeRuns).toBeUndefined();
    expect(missing.body.armedSchedules).toBeUndefined();

    const wrong = await getQuitGuard(`Bearer ${SERVER_AUTH_TOKEN}x`);
    expect(wrong.status).toBe(403);
    expect(wrong.text).not.toContain('activeRuns');
    expect(wrong.text).not.toContain('armedSchedules');
    expect(wrong.body.activeRuns).toBeUndefined();
    expect(wrong.body.armedSchedules).toBeUndefined();
  });

  it('returns 200 and only integer activeRuns and armedSchedules with a valid token', async () => {
    const result = await getQuitGuard(`Bearer ${SERVER_AUTH_TOKEN}`);
    expect(result.status).toBe(200);
    expect(Object.keys(result.body)).toEqual(['activeRuns', 'armedSchedules']);
    expect(Number.isInteger(result.body.activeRuns)).toBe(true);
    expect(Number.isInteger(result.body.armedSchedules)).toBe(true);
  });

  it('counts registry runs and enabled cron jobs, and uses 0 activeRuns when the registry is not configured', async () => {
    const jobs = [{ enabled: true }, { enabled: true }, { enabled: false }];
    listJobs.mockImplementation((filter?: { enabled?: boolean }) => {
      if (filter?.enabled === undefined) return jobs;
      return jobs.filter((job) => job.enabled === filter.enabled);
    });

    const unconfigured = await getQuitGuard(`Bearer ${SERVER_AUTH_TOKEN}`);
    expect(unconfigured.status).toBe(200);
    expect(unconfigured.body).toEqual({ activeRuns: 0, armedSchedules: 2 });
    expect(listJobs).toHaveBeenCalledWith({ enabled: true });

    getApplicationRunRegistry().start({
      runId: 'quit-guard-run',
      sessionId: 'quit-guard-session',
      workspace: process.cwd(),
    });
    const running = await getQuitGuard(`Bearer ${SERVER_AUTH_TOKEN}`);
    expect(running.status).toBe(200);
    expect(running.body).toEqual({ activeRuns: 1, armedSchedules: 2 });
  });

  it('returns 500 and no numeric fields when the snapshot source throws', async () => {
    listJobs.mockImplementation(() => {
      throw new Error('cron unavailable');
    });
    const result = await getQuitGuard(`Bearer ${SERVER_AUTH_TOKEN}`);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'quit-guard-unavailable' });
    expect(result.text).not.toContain('activeRuns');
    expect(result.text).not.toContain('armedSchedules');
    expect(Object.values(result.body).some((value) => typeof value === 'number')).toBe(false);
  });

  it('keeps unauthenticated GET /api/health free of quit-guard keys', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(Object.keys(body)).toEqual(HEALTH_KEYS);
    expect(body).not.toHaveProperty('activeRuns');
    expect(body).not.toHaveProperty('armedSchedules');
    expect(body).not.toHaveProperty('quitGuard');
  });
});

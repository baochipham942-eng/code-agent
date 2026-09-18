import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

const harness = vi.hoisted(() => ({
  db: null as InstanceType<typeof Database> | null,
  companionRun: vi.fn(async () => ({ runId: 'fresh-run' })),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => harness.db,
    getSession: (id: string) => ({ id, title: id, workingDirectory: '/tmp/companion-send-host', projectId: null }),
    getProjectRepo: () => ({ getProject: () => null, listProjects: () => [] }),
  }),
}));

vi.mock('../../../src/web/routes/agent', async () => {
  const { Router } = await import('express');
  return {
    createAgentRouter: (deps: { registerCompanionRun?: (run: typeof harness.companionRun) => void }) => {
      deps.registerCompanionRun?.(harness.companionRun);
      return Router();
    },
  };
});

vi.mock('../../../src/host/services/companion/CompanionRelayClient', () => ({
  startCompanionRelayIfConfigured: async () => null,
  // 账号通道是同步返回 handle|null（app.ts 不 await）；返回 Promise 会让 shutdown 的 ?.stop() 炸。
  startCompanionRelayAccountIfConfigured: () => null,
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: 'user-1' }) }),
}));

import { createApp, type CreateAppDeps } from '../../../src/web/app';
import { SteerRejectedError } from '../../../src/host/agent/runtime/conversationRuntime';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';

const liveSession = 'session-live';
const idleSession = 'session-idle';
const deviceId = 'phone';
const credential = 'phone-secret';

function buildDeps(dataDir: string, runRegistry: RunRegistry, stop: { current?: () => Promise<void> }): CreateAppDeps {
  const companionUnavailable: unknown[][] = [];
  return {
    handlers: new Map(),
    logger: {
      info: () => {},
      warn: (message, ...rest) => {
        if (String(message).includes('Companion routes unavailable')) companionUnavailable.push([message, ...rest]);
      },
      error: () => {},
    },
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
    registerCompanionShutdown: (fn) => { stop.current = fn; },
    _companionUnavailable: companionUnavailable,
  } as CreateAppDeps & { _companionUnavailable: unknown[][] };
}

describe('createApp wires message.send through the live run (steer / queued / idle)', () => {
  let dataDir: string;
  let db: Database.Database;
  let registry: RunRegistry;
  let server: http.Server;
  let base: string;
  let stopCompanion: { current?: () => Promise<void> };
  let rejectSteer: boolean;
  const headers = {
    'content-type': 'application/json',
    'x-neo-companion-device': deviceId,
    'x-neo-companion-credential': credential,
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(joinTmp('neo-companion-send-'));
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS queued_inputs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        retry_count INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        paused_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    harness.db = db;
    harness.companionRun.mockClear();
    rejectSteer = false;
    registry = new RunRegistry();
    stopCompanion = {};
    const deps = buildDeps(dataDir, registry, stopCompanion);
    const app = createApp(deps);
    expect((deps as CreateAppDeps & { _companionUnavailable: unknown[][] })._companionUnavailable).toEqual([]);
    const run = registry.start({ sessionId: liveSession, runId: 'run-live', workspace: dataDir, cwd: dataDir });
    await run.attach({
      cancel: () => {},
      steer: async () => {
        if (rejectSteer) throw new SteerRejectedError();
      },
    });
    db.prepare(`
      INSERT INTO companion_devices (device_id, credential_hash, scope_json, scope_epoch, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      deviceId,
      createHash('sha256').update(credential).digest('hex'),
      JSON.stringify([liveSession, idleSession]),
      1,
      null,
      Date.now(),
    );
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await stopCompanion.current?.();
    registry?.clear();
    db?.close();
    harness.db = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function joinTmp(prefix: string) {
    return path.join(tmpdir(), prefix);
  }

  async function submit(commandId: string, sessionId: string, text: string) {
    const response = await fetch(`${base}/companion/commands`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        deviceId,
        scopeEpoch: 1,
        commandId,
        sessionId,
        action: 'message.send',
        payload: { text },
      }),
    });
    return { response, body: await response.json() as { success?: boolean; data?: { kind?: string; command?: { state: string; result: Record<string, unknown> } }; error?: unknown } };
  }

  async function settled(commandId: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const body = await (await fetch(`${base}/companion/commands/${commandId}`, { headers })).json() as {
        data?: { kind?: string; command?: { state: string; result: Record<string, unknown> } };
      };
      if (body.data?.kind === 'found' && body.data.command && body.data.command.state !== 'reconciling') {
        return body.data.command;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`command ${commandId} did not settle`);
  }

  async function messageEvents() {
    const body = await (await fetch(`${base}/companion/sync?epoch=1&afterSeq=0`, { headers })).json() as {
      data?: { events?: Array<{ kind: string; payload: Record<string, unknown> }> };
    };
    return (body.data?.events ?? []).filter(event => event.kind === 'message');
  }

  it('active run: does not call companionRun, accepts with runId+outcome, publishes role=user message', async () => {
    const posted = await submit('cmd-steer', liveSession, '再加一页对比');
    expect(posted.response.status).toBe(202);
    expect(posted.body.data?.command).toMatchObject({ state: 'reconciling' });
    const command = await settled('cmd-steer');
    expect(harness.companionRun).not.toHaveBeenCalled();
    expect(command).toMatchObject({
      state: 'accepted',
      result: { runId: 'run-live', outcome: 'steered' },
    });
    expect(await messageEvents()).toEqual([
      expect.objectContaining({
        kind: 'message',
        payload: { id: 'cmd-steer', role: 'user', content: '再加一页对比', runId: 'run-live' },
      }),
    ]);
  });

  it('steer rejected: queues and the message event carries queued:true', async () => {
    rejectSteer = true;
    const posted = await submit('cmd-queue', liveSession, '这轮做完接着做之前先记下');
    expect(posted.response.status).toBe(202);
    const command = await settled('cmd-queue');
    expect(harness.companionRun).not.toHaveBeenCalled();
    expect(command).toMatchObject({
      state: 'accepted',
      result: { runId: 'run-live', outcome: 'queued' },
    });
    expect(await messageEvents()).toEqual([
      expect.objectContaining({
        kind: 'message',
        payload: {
          id: 'cmd-queue',
          role: 'user',
          content: '这轮做完接着做之前先记下',
          runId: 'run-live',
          queued: true,
        },
      }),
    ]);
  });

  it('no active run still goes through companionRun', async () => {
    const posted = await submit('cmd-idle', idleSession, '新开一轮');
    expect(posted.response.status).toBe(202);
    const command = await settled('cmd-idle');
    expect(harness.companionRun).toHaveBeenCalledTimes(1);
    expect(harness.companionRun).toHaveBeenCalledWith({
      version: 1,
      prompt: '新开一轮',
      sessionId: idleSession,
      clientMessageId: 'cmd-idle',
    });
    expect(command).toMatchObject({
      state: 'accepted',
      result: { runId: 'fresh-run' },
    });
    expect(command.result).not.toHaveProperty('outcome');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import type BetterSqlite3 from 'better-sqlite3';

vi.unmock('better-sqlite3');

vi.hoisted(() => {
  delete process.env.CODE_AGENT_CLI_MODE;
  process.env.CODE_AGENT_WEB_MODE = '1';
});

const databaseState = vi.hoisted(() => ({
  service: null as import('../../../src/host/services/core/databaseService').DatabaseService | null,
}));

vi.mock('../../../src/host/services/core/databaseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/core/databaseService')>();
  return {
    ...actual,
    getDatabase: () => {
      if (!databaseState.service) throw new Error('test database is not ready');
      return databaseState.service;
    },
  };
});

import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { getSessionEventService } from '../../../src/host/session/sessionEventService';

describe('SessionEventService database handle lifecycle', () => {
  let dataDir: string;
  let database: DatabaseService | null = null;
  let server: ChildProcess | null = null;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'session-events-reopen-'));
  });

  afterEach(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    server = null;
    await getSessionEventService().dispose();
    database?.close();
    database = null;
    databaseState.service = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes events after reopening the database and through the bundled web run entry', async () => {
    database = new DatabaseService(dataDir);
    await database.initialize();
    databaseState.service = database;
    database.createSessionWithId('session-reopen', {
      title: 'session reopen',
      modelConfig: { provider: 'openai', model: 'test-model' },
    });

    const eventService = getSessionEventService();
    eventService.saveEvent('session-reopen', { type: 'agent_complete', data: null });
    expect(database.getDb()?.prepare('SELECT COUNT(*) AS count FROM session_events').get()).toEqual({ count: 1 });

    database.close();
    database = new DatabaseService(dataDir);
    await database.initialize();
    databaseState.service = database;

    eventService.saveEvent('session-reopen', { type: 'agent_complete', data: null });

    expect(database.getDb()?.prepare('SELECT COUNT(*) AS count FROM session_events').get()).toEqual({ count: 2 });

    // Build the real web entry into an isolated artifact: source imports alone
    // cannot catch a require alias left unresolved by the CJS bundler.
    const bundle = join(dataDir, 'webServer.cjs');
    await build({
      entryPoints: ['src/web/webServer.ts'],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      external: ['better-sqlite3', 'keytar', 'playwright', 'playwright-core', 'chromium-bidi',
        'sharp', 'node-pty', '@ui-tars/sdk', 'onnxruntime-node'],
      alias: { electron: './src/web/electronMock.ts', pdfkit: 'pdfkit/js/pdfkit.standalone.js' },
    });
    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const address = portProbe.address();
    if (!address || typeof address === 'string') throw new Error('test port is unavailable');
    const port = address.port;
    await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
    const webDataDir = join(dataDir, 'web-data');
    server = spawn(process.execPath, [bundle], {
      env: {
        ...process.env,
        HOME: dataDir,
        CODE_AGENT_DATA_DIR: webDataDir,
        CODE_AGENT_E2E: '1',
        CODE_AGENT_SERVICE_MODE: '1',
        CODE_AGENT_WEB_AUTH_TOKEN: 'session-events-test',
        CODE_AGENT_RENDERER_HOT_UPDATE: 'false',
        EVAL_DISABLED: 'false',
        WEB_PORT: String(port),
        NODE_ENV: 'production',
        NODE_PATH: join(process.cwd(), 'node_modules'),
        VITEST: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout?.on('data', chunk => { output += String(chunk); });
    server.stderr?.on('data', chunk => { output += String(chunk); });
    const baseUrl = `http://127.0.0.1:${port}`;
    await vi.waitFor(async () => {
      expect((await fetch(`${baseUrl}/api/health`)).ok, output).toBe(true);
    }, { timeout: 15_000, interval: 100 });

    // A missing-key model deliberately stops before paid inference. AgentLoop
    // still emits the lifecycle events whose durable side effect is under test.
    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST',
      headers: { Authorization: 'Bearer session-events-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Reply OK.', sessionId: 'session-bundle', project: dataDir,
        provider: 'openai', model: 'test-no-key', disableAutoAgent: true,
      }),
    });
    expect(response.ok, output).toBe(true);
    expect(await response.text()).toContain('event: turn_start');
    const Database = createRequire(import.meta.url)('better-sqlite3') as typeof BetterSqlite3;
    const sqlite = new Database(join(webDataDir, 'code-agent.db'), { readonly: true });
    try {
      const messageCount = sqlite.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?')
        .get('session-bundle') as { count: number };
      const eventCount = sqlite.prepare('SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?')
        .get('session-bundle') as { count: number };
      expect(messageCount.count).toBeGreaterThan(0);
      expect(eventCount.count, output).toBeGreaterThan(0);
    } finally {
      sqlite.close();
    }
  });
});

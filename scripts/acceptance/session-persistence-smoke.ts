#!/usr/bin/env npx tsx

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { access, mkdtemp, rm } from 'fs/promises';
import { constants } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

type ApiResult<T> = {
  success: boolean;
  data?: T;
  error?: { message?: string };
};

type SessionSummary = {
  id: string;
  title: string;
};

type StartedServer = {
  baseUrl: string;
  token: string;
  child: ChildProcessWithoutNullStreams;
  output: () => string;
};

async function ensureBuiltWebServer(): Promise<void> {
  try {
    await access(path.join(process.cwd(), 'dist', 'web', 'webServer.cjs'), constants.R_OK);
  } catch {
    throw new Error('dist/web/webServer.cjs is missing. Run npm run build:web before this smoke.');
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function extractStartupToken(output: string, port: number): string | null {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line) as { port?: unknown; token?: unknown };
      if (parsed.port === port && typeof parsed.token === 'string' && parsed.token.length > 0) {
        return parsed.token;
      }
    } catch {
      // Ignore non-startup JSON logs.
    }
  }
  return null;
}

async function waitForServer(server: StartedServer, port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = '';

  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`webServer exited early with ${server.child.exitCode}\n${server.output()}`);
    }

    const token = extractStartupToken(server.output(), port);
    if (token) {
      server.token = token;
      try {
        const response = await fetch(`${server.baseUrl}/api/health`);
        const health = await response.json() as {
          status?: string;
          persistence?: { status?: string; durable?: boolean; reason?: string };
        };
        if (response.ok && health.status === 'ok') {
          if (health.persistence?.status !== 'available' || health.persistence.durable !== true) {
            throw new Error(`persistence is not durable: ${JSON.stringify(health.persistence)}`);
          }
          return;
        }
        lastError = JSON.stringify(health);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for webServer. Last error: ${lastError}\n${server.output()}`);
}

async function startServer(dataDir: string): Promise<StartedServer> {
  const port = await getFreePort();
  const outputChunks: string[] = [];
  const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'web', 'webServer.cjs')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_E2E: '1',
      CODE_AGENT_WORKING_DIR: process.cwd(),
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      AGENT_NEO_BUNDLED_RUNTIME_ROOT: process.cwd(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => outputChunks.push(String(chunk)));
  child.stderr.on('data', (chunk) => outputChunks.push(String(chunk)));

  const server: StartedServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    token: '',
    child,
    output: () => outputChunks.join('').slice(-8000),
  };

  await waitForServer(server, port);
  return server;
}

async function stopServer(server: StartedServer): Promise<void> {
  if (server.child.exitCode !== null) return;

  server.child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return;
    await delay(100);
  }
  server.child.kill('SIGKILL');
}

async function api<T>(
  server: StartedServer,
  pathname: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${server.token}`,
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json() as ApiResult<T>;
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error?.message || `Request failed: ${response.status} ${pathname}`);
  }
  return payload.data as T;
}

async function main(): Promise<void> {
  await ensureBuiltWebServer();

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-session-persistence-'));
  let server: StartedServer | null = null;

  try {
    server = await startServer(dataDir);
    const created = await api<SessionSummary>(server, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'release persistence smoke',
        workingDirectory: process.cwd(),
      }),
    });
    await stopServer(server);

    server = await startServer(dataDir);
    const sessions = await api<SessionSummary[]>(server, '/api/sessions');
    const restored = sessions.find((session) => session.id === created.id);
    if (!restored) {
      throw new Error(`Created session ${created.id} was not restored after webServer restart`);
    }

    console.log(JSON.stringify({
      ok: true,
      dataDir,
      sessionId: created.id,
      restoredTitle: restored.title,
    }, null, 2));
  } finally {
    if (server) await stopServer(server);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

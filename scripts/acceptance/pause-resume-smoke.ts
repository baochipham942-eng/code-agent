#!/usr/bin/env npx tsx

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { access, mkdtemp, rm } from 'fs/promises';
import { constants } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

type ApiFailure = {
  error?: string | { message?: string };
};

type StartedServer = {
  baseUrl: string;
  token: string;
  child: ChildProcessWithoutNullStreams;
  output: () => string;
};

type AgentLoopStubState = {
  ok: boolean;
  id: string | null;
  sessionId: string;
  exists: boolean;
  active: boolean;
  createdAt: number | null;
  cancelledAt: number | null;
  cancelCount: number;
  paused: boolean;
  pauseCount: number;
  resumedAt: number | null;
  resumeCount: number;
};

type WrappedResponse<T> = {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
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
  const deadline = Date.now() + 90_000;
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
        const health = await response.json() as { status?: string };
        if (response.ok && health.status === 'ok') return;
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
    output: () => outputChunks.join('').slice(-80_000),
  };

  try {
    await waitForServer(server, port);
    return server;
  } catch (error) {
    await stopServer(server).catch(() => undefined);
    throw error;
  }
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

function readError(payload: ApiFailure | WrappedResponse<unknown>): string | undefined {
  if ('error' in payload && typeof payload.error === 'string') return payload.error;
  return payload.error?.message;
}

async function requestJson<T>(
  server: StartedServer,
  method: 'GET' | 'POST' | 'DELETE',
  pathname: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${server.token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({})) as T & ApiFailure;
  if (!response.ok) {
    throw new Error(readError(payload) || `Request failed: ${response.status} ${method} ${pathname}`);
  }
  return payload;
}

async function createStub(server: StartedServer, sessionId: string): Promise<AgentLoopStubState> {
  return requestJson<AgentLoopStubState>(server, 'POST', '/api/dev/agent-loop-stub', { sessionId });
}

async function readStub(server: StartedServer, sessionId: string): Promise<AgentLoopStubState> {
  return requestJson<AgentLoopStubState>(server, 'GET', `/api/dev/agent-loop-stub/${encodeURIComponent(sessionId)}`);
}

async function deleteStub(server: StartedServer, sessionId: string): Promise<void> {
  await requestJson(server, 'DELETE', `/api/dev/agent-loop-stub/${encodeURIComponent(sessionId)}`);
}

async function runPauseResumeSmoke(server: StartedServer, sessionId: string): Promise<{
  created: AgentLoopStubState;
  paused: AgentLoopStubState;
  resumed: AgentLoopStubState;
}> {
  const created = await createStub(server, sessionId);
  if (!created.ok || !created.id || !created.active || !created.exists || created.paused) {
    throw new Error(`Agent loop stub did not start active: ${JSON.stringify(created)}`);
  }

  const pauseResponse = await requestJson<WrappedResponse<{ sessionId: string; message: string }>>(
    server,
    'POST',
    '/api/pause',
    { sessionId },
  );
  if (!pauseResponse.success || pauseResponse.data?.sessionId !== sessionId) {
    throw new Error(`Pause route returned unexpected payload: ${JSON.stringify(pauseResponse)}`);
  }

  const paused = await readStub(server, sessionId);
  if (paused.id !== created.id || !paused.active || !paused.paused || paused.pauseCount !== 1) {
    throw new Error(`Pause did not preserve and pause the active loop: ${JSON.stringify({ created, paused })}`);
  }

  const resumeResponse = await requestJson<WrappedResponse<{ sessionId: string; message: string }>>(
    server,
    'POST',
    '/api/resume',
    { sessionId },
  );
  if (!resumeResponse.success || resumeResponse.data?.sessionId !== sessionId) {
    throw new Error(`Resume route returned unexpected payload: ${JSON.stringify(resumeResponse)}`);
  }

  const resumed = await readStub(server, sessionId);
  if (resumed.id !== created.id || !resumed.active || resumed.paused || resumed.resumeCount !== 1) {
    throw new Error(`Resume did not preserve and resume the active loop: ${JSON.stringify({ created, resumed })}`);
  }

  return { created, paused, resumed };
}

async function main(): Promise<void> {
  await ensureBuiltWebServer();

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-pause-resume-'));
  const sessionId = `pause-resume-smoke-${Date.now()}`;
  let server: StartedServer | null = null;
  let cleanupStub = false;

  try {
    server = await startServer(dataDir);
    const result = await runPauseResumeSmoke(server, sessionId);
    cleanupStub = true;

    console.log(JSON.stringify({
      ok: true,
      dataDir,
      sessionId,
      loopId: result.created.id,
      pause: {
        active: result.paused.active,
        paused: result.paused.paused,
        pauseCount: result.paused.pauseCount,
      },
      resume: {
        active: result.resumed.active,
        paused: result.resumed.paused,
        resumeCount: result.resumed.resumeCount,
      },
    }, null, 2));
  } finally {
    if (server && cleanupStub) {
      await deleteStub(server, sessionId).catch(() => undefined);
    }
    if (server) await stopServer(server);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

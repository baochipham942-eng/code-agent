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

type CancellableToolState = {
  ok: boolean;
  id: string;
  tool: string;
  sessionId: string;
  startedAt: number;
  cancelledAt?: number;
  settledAt?: number;
  elapsedMs: number;
  startedPid: string | null;
  terminatedSignal: string | null;
  requestStarted: string | null;
  requestClosed: string | null;
  url?: string;
  settled: boolean;
  result?: {
    success: boolean;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  };
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

function readError(payload: ApiFailure): string | undefined {
  if (typeof payload.error === 'string') return payload.error;
  return payload.error?.message;
}

async function postRaw<T>(
  server: StartedServer,
  pathname: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${server.token}`,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json() as T & ApiFailure;
  if (!response.ok) {
    throw new Error(readError(payload) || `Request failed: ${response.status} ${pathname}`);
  }
  return payload;
}

async function deleteRaw(
  server: StartedServer,
  pathname: string,
): Promise<void> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${server.token}`,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as ApiFailure;
    throw new Error(readError(payload) || `Request failed: ${response.status} ${pathname}`);
  }
}

async function runCancellableToolSmoke(
  server: StartedServer,
  cleanupRunIds: Set<string>,
  request: {
    tool: 'Bash' | 'http_request';
    sessionId: string;
  },
): Promise<CancellableToolState> {
  const started = await postRaw<CancellableToolState>(
    server,
    '/api/dev/cancellable-tool/start',
    {
      tool: request.tool,
      sessionId: request.sessionId,
      workingDirectory: process.cwd(),
    },
  );
  cleanupRunIds.add(started.id);
  if (started.tool !== request.tool || started.settled) {
    throw new Error(`Cancellable ${request.tool} tool did not start correctly: ${JSON.stringify(started)}`);
  }
  if (request.tool === 'Bash' && !started.startedPid) {
    throw new Error(`Cancellable Bash process did not expose a started PID: ${JSON.stringify(started)}`);
  }
  if (request.tool === 'http_request' && (!started.requestStarted || !started.url)) {
    throw new Error(`Cancellable http_request did not reach the delay server: ${JSON.stringify(started)}`);
  }

  await delay(250);
  const cancelled = await postRaw<CancellableToolState>(
    server,
    `/api/dev/cancellable-tool/${encodeURIComponent(started.id)}/cancel`,
    {},
  );
  if (!cancelled.settled) {
    throw new Error(`Cancellable ${request.tool} tool did not settle after cancel: ${JSON.stringify(cancelled)}`);
  }
  if (cancelled.result?.success !== false || cancelled.result.error !== 'aborted') {
    throw new Error(`Cancellable ${request.tool} tool did not report aborted: ${JSON.stringify(cancelled)}`);
  }
  if (cancelled.elapsedMs > 10_000) {
    throw new Error(`Cancellable ${request.tool} tool took too long to cancel: ${JSON.stringify(cancelled)}`);
  }
  if (request.tool === 'Bash' && cancelled.terminatedSignal !== 'SIGTERM') {
    throw new Error(`Cancellable Bash process did not receive SIGTERM: ${JSON.stringify(cancelled)}`);
  }
  if (request.tool === 'http_request' && cancelled.requestClosed !== 'client_closed') {
    throw new Error(`Cancellable http_request did not close the in-flight request: ${JSON.stringify(cancelled)}`);
  }

  await deleteRaw(server, `/api/dev/cancellable-tool/${encodeURIComponent(started.id)}`);
  cleanupRunIds.delete(started.id);
  return cancelled;
}

async function main(): Promise<void> {
  await ensureBuiltWebServer();

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-tool-cancel-'));
  let server: StartedServer | null = null;
  const cleanupRunIds = new Set<string>();

  try {
    server = await startServer(dataDir);
    const bashSessionId = `tool-cancel-bash-smoke-${Date.now()}`;
    const bashCancelled = await runCancellableToolSmoke(server, cleanupRunIds, {
      tool: 'Bash',
      sessionId: bashSessionId,
    });

    const httpSessionId = `tool-cancel-http-smoke-${Date.now()}`;
    const httpCancelled = await runCancellableToolSmoke(server, cleanupRunIds, {
      tool: 'http_request',
      sessionId: httpSessionId,
    });

    console.log(JSON.stringify({
      ok: true,
      dataDir,
      bash: {
        sessionId: bashSessionId,
        runId: bashCancelled.id,
        startedPid: bashCancelled.startedPid,
        terminatedSignal: bashCancelled.terminatedSignal,
        resultError: bashCancelled.result?.error,
        elapsedMs: bashCancelled.elapsedMs,
      },
      httpRequest: {
        sessionId: httpSessionId,
        runId: httpCancelled.id,
        url: httpCancelled.url,
        requestStarted: httpCancelled.requestStarted,
        requestClosed: httpCancelled.requestClosed,
        resultError: httpCancelled.result?.error,
        elapsedMs: httpCancelled.elapsedMs,
      },
    }, null, 2));
  } finally {
    if (server) {
      for (const runId of cleanupRunIds) {
        await deleteRaw(server, `/api/dev/cancellable-tool/${encodeURIComponent(runId)}`).catch(() => undefined);
      }
    }
    if (server) await stopServer(server);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

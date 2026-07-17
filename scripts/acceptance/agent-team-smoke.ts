#!/usr/bin/env npx tsx

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'node:stream';
import { access, mkdtemp, rm } from 'fs/promises';
import { constants } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

type ApiFailure = {
  error?: string | { message?: string };
};

type SmokeTaskResult = {
  taskId: string;
  success: boolean;
  blocked: boolean;
  cancelled: boolean;
  error?: string;
  output?: string;
};

type SmokeScenarioSummary = {
  success: boolean;
  results: SmokeTaskResult[];
  errors: Array<{ taskId: string; error: string }>;
};

type AgentTeamSmokeResponse = {
  ok: boolean;
  sessionId: string;
  dependency: SmokeScenarioSummary;
  message: SmokeScenarioSummary & {
    sent: boolean;
    deliveredMessage: string;
  };
  cancel: SmokeScenarioSummary;
};

type StartedServer = {
  baseUrl: string;
  token: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
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
      CODE_AGENT_E2E_LOCAL_SUBAGENT_EXECUTOR: '1',
      CODE_AGENT_E2E_LOCAL_SUBAGENT_DELAY_MS: '350',
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

async function requestJson<T>(
  server: StartedServer,
  method: 'POST',
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

function findTask(summary: SmokeScenarioSummary, taskId: string): SmokeTaskResult {
  const task = summary.results.find((item) => item.taskId === taskId);
  if (!task) {
    throw new Error(`Missing task ${taskId}: ${JSON.stringify(summary)}`);
  }
  return task;
}

function verifySmoke(result: AgentTeamSmokeResponse): void {
  if (!result.ok) {
    throw new Error(`Agent Team smoke did not return ok: ${JSON.stringify(result)}`);
  }

  const dependencyRoot = findTask(result.dependency, 'dep-root');
  const dependencyChild = findTask(result.dependency, 'dep-child');
  if (dependencyRoot.success || !dependencyChild.blocked) {
    throw new Error(`Dependency smoke failed: ${JSON.stringify(result.dependency)}`);
  }

  const messageTask = findTask(result.message, 'message-agent');
  if (!result.message.sent || !messageTask.success || !messageTask.output?.includes(result.message.deliveredMessage)) {
    throw new Error(`Message smoke failed: ${JSON.stringify(result.message)}`);
  }

  const cancelRunning = findTask(result.cancel, 'cancel-running');
  const cancelPending = findTask(result.cancel, 'cancel-pending');
  if (!cancelRunning.cancelled || !cancelPending.cancelled) {
    throw new Error(`Cancel smoke failed: ${JSON.stringify(result.cancel)}`);
  }
}

async function main(): Promise<void> {
  await ensureBuiltWebServer();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-agent-team-smoke-'));
  let server: StartedServer | null = null;

  try {
    server = await startServer(dataDir);
    const result = await requestJson<AgentTeamSmokeResponse>(
      server,
      'POST',
      '/api/dev/agent-team-smoke',
    );
    verifySmoke(result);
    console.log(JSON.stringify({
      ok: true,
      dataDir,
      sessionId: result.sessionId,
      dependency: {
        root: findTask(result.dependency, 'dep-root'),
        child: findTask(result.dependency, 'dep-child'),
      },
      message: {
        sent: result.message.sent,
        output: findTask(result.message, 'message-agent').output,
      },
      cancel: {
        running: findTask(result.cancel, 'cancel-running'),
        pending: findTask(result.cancel, 'cancel-pending'),
      },
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

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

type StartedServer = {
  baseUrl: string;
  token: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
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

type SessionSummary = {
  id: string;
  title: string;
};

type BackgroundTaskInfo = {
  sessionId: string;
  title: string;
  startedAt: number;
  backgroundedAt: number;
  status: 'running' | 'completed' | 'failed';
  progress?: number;
  completionMessage?: string;
};

type RecordedNotification = {
  id: string;
  type: 'needs_input' | 'task_complete';
  sessionId: string;
  title: string;
  body: string;
  createdAt: number;
  delivery: 'sent' | 'dry_run';
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
      CODE_AGENT_NOTIFICATION_DRY_RUN: '1',
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
  const error = 'error' in payload ? payload.error : undefined;
  if (typeof error === 'string') return error;
  return error?.message;
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

async function createSession(server: StartedServer): Promise<SessionSummary> {
  const response = await requestJson<WrappedResponse<SessionSummary>>(server, 'POST', '/api/sessions', {
    title: `pause-resume-background-${Date.now()}`,
    workingDirectory: process.cwd(),
  });
  if (!response.success || !response.data?.id) {
    throw new Error(`Session creation returned unexpected payload: ${JSON.stringify(response)}`);
  }
  return response.data;
}

async function listBackgroundTasks(server: StartedServer): Promise<BackgroundTaskInfo[]> {
  const response = await requestJson<WrappedResponse<BackgroundTaskInfo[]>>(server, 'GET', '/api/background/tasks');
  if (!response.success || !Array.isArray(response.data)) {
    throw new Error(`Background task list returned unexpected payload: ${JSON.stringify(response)}`);
  }
  return response.data;
}

async function clearNotifications(server: StartedServer): Promise<void> {
  await requestJson(server, 'DELETE', '/api/dev/notifications');
}

async function listNotifications(server: StartedServer): Promise<RecordedNotification[]> {
  const response = await requestJson<{ ok: boolean; notifications: RecordedNotification[] }>(
    server,
    'GET',
    '/api/dev/notifications',
  );
  if (!response.ok || !Array.isArray(response.notifications)) {
    throw new Error(`Notification list returned unexpected payload: ${JSON.stringify(response)}`);
  }
  return response.notifications;
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

async function runBackgroundNotificationSmoke(
  server: StartedServer,
  sessionId: string,
): Promise<{
  runningTask: BackgroundTaskInfo;
  completedTask: BackgroundTaskInfo;
  notification: RecordedNotification;
  foregroundTask: BackgroundTaskInfo;
}> {
  const backgroundResponse = await requestJson<WrappedResponse<{ sessionId: string }>>(
    server,
    'POST',
    '/api/background/move-to-background',
    { sessionId },
  );
  if (!backgroundResponse.success || backgroundResponse.data?.sessionId !== sessionId) {
    throw new Error(`Move-to-background returned unexpected payload: ${JSON.stringify(backgroundResponse)}`);
  }

  const runningTask = (await listBackgroundTasks(server)).find((task) => task.sessionId === sessionId);
  if (!runningTask || runningTask.status !== 'running') {
    throw new Error(`Session did not appear as a running background task: ${JSON.stringify(runningTask)}`);
  }

  const completionMessage = 'long task completed while in background';
  const completeResponse = await requestJson<{ ok: boolean; sessionId: string }>(
    server,
    'POST',
    '/api/dev/background-task/complete',
    { sessionId, message: completionMessage },
  );
  if (!completeResponse.ok || completeResponse.sessionId !== sessionId) {
    throw new Error(`Background completion returned unexpected payload: ${JSON.stringify(completeResponse)}`);
  }

  const completedTask = (await listBackgroundTasks(server)).find((task) => task.sessionId === sessionId);
  if (
    !completedTask
    || completedTask.status !== 'completed'
    || completedTask.progress !== 100
    || completedTask.completionMessage !== completionMessage
  ) {
    throw new Error(`Background task did not complete with message/progress: ${JSON.stringify(completedTask)}`);
  }

  const notification = (await listNotifications(server)).find((entry) => (
    entry.sessionId === sessionId
    && entry.type === 'task_complete'
    && entry.delivery === 'dry_run'
    && entry.body.includes(completionMessage)
  ));
  if (!notification) {
    throw new Error(`Task completion notification was not recorded for ${sessionId}`);
  }

  const foregroundResponse = await requestJson<WrappedResponse<BackgroundTaskInfo>>(
    server,
    'POST',
    '/api/background/move-to-foreground',
    { sessionId },
  );
  if (!foregroundResponse.success || foregroundResponse.data?.sessionId !== sessionId) {
    throw new Error(`Move-to-foreground returned unexpected payload: ${JSON.stringify(foregroundResponse)}`);
  }

  const remainingTask = (await listBackgroundTasks(server)).find((task) => task.sessionId === sessionId);
  if (remainingTask) {
    throw new Error(`Background task remained after foreground restore: ${JSON.stringify(remainingTask)}`);
  }

  return {
    runningTask,
    completedTask,
    notification,
    foregroundTask: foregroundResponse.data,
  };
}

async function main(): Promise<void> {
  await ensureBuiltWebServer();

  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-pause-resume-'));
  let server: StartedServer | null = null;
  let sessionId: string | null = null;
  let cleanupStub = false;

  try {
    server = await startServer(dataDir);
    await clearNotifications(server);
    const session = await createSession(server);
    sessionId = session.id;
    const result = await runPauseResumeSmoke(server, sessionId);
    const background = await runBackgroundNotificationSmoke(server, sessionId);
    cleanupStub = true;

    console.log(JSON.stringify({
      ok: true,
      dataDir,
      sessionId,
      loopId: result.created.id,
      background: {
        runningStatus: background.runningTask.status,
        completedStatus: background.completedTask.status,
        restoredToForeground: background.foregroundTask.sessionId === sessionId,
      },
      notification: {
        type: background.notification.type,
        delivery: background.notification.delivery,
        title: background.notification.title,
      },
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
    if (server && cleanupStub && sessionId) {
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

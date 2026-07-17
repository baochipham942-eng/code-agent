#!/usr/bin/env npx tsx

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'node:stream';
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

type DevToolExecutionResponse = {
  tool: string;
  params: Record<string, unknown>;
  project: string;
  sessionId: string;
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  result?: unknown;
};

type TaskSummary = {
  id: string;
  subject: string;
  status: string;
};

type ContextInterventionSnapshot = {
  pinned: string[];
  excluded: string[];
  retained: string[];
};

type TodoItem = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
};

type DevTodosResponse = {
  ok: boolean;
  sessionId: string;
  todos: TodoItem[];
};

type DevCompactStateResponse = {
  ok: boolean;
  sessionId: string;
  compactionMessages: Array<{
    id: string;
    source?: string;
    compactedMessageCount: number;
    compactedMessageIds: string[];
    preservedMessageIds: string[];
  }>;
  compressionCommitCount: number;
  compressionTargetIds: string[];
};

type DevReplayStateResponse = {
  ok: boolean;
  sessionId: string;
  replayKey: string | null;
  dataSource: string | null;
  turnCount: number;
  telemetryCompleteness: unknown;
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

async function execDevTool(
  server: StartedServer,
  request: {
    tool: string;
    params?: Record<string, unknown>;
    sessionId: string;
    allowWrite?: boolean;
  },
): Promise<DevToolExecutionResponse> {
  const response = await fetch(`${server.baseUrl}/api/dev/exec-tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${server.token}`,
    },
    body: JSON.stringify({
      ...request,
      project: process.cwd(),
    }),
  });

  const payload = await response.json() as DevToolExecutionResponse & { code?: string };
  if (!response.ok || payload.success === false) {
    throw new Error(payload.error || `Dev tool failed: ${response.status} ${request.tool}`);
  }
  return payload;
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

  const payload = await response.json() as T & { error?: { message?: string } | string };
  if (!response.ok) {
    const error = typeof payload.error === 'string'
      ? payload.error
      : payload.error?.message;
    throw new Error(error || `Request failed: ${response.status} ${pathname}`);
  }
  return payload;
}

async function getRaw<T>(
  server: StartedServer,
  pathname: string,
): Promise<T> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    headers: {
      Authorization: `Bearer ${server.token}`,
    },
  });

  const payload = await response.json() as T & { error?: { message?: string } | string };
  if (!response.ok) {
    const error = typeof payload.error === 'string'
      ? payload.error
      : payload.error?.message;
    throw new Error(error || `Request failed: ${response.status} ${pathname}`);
  }
  return payload;
}

function getCreatedTaskId(response: DevToolExecutionResponse): string {
  const taskId = response.metadata?.taskId;
  if (typeof taskId === 'string' && taskId) return taskId;

  const task = response.metadata?.task;
  if (task && typeof task === 'object') {
    const id = (task as { id?: unknown }).id;
    if (typeof id === 'string' && id) return id;
  }

  throw new Error(`task_create did not return a task id: ${JSON.stringify(response)}`);
}

function getListedTasks(response: DevToolExecutionResponse): TaskSummary[] {
  const tasks = response.metadata?.tasks;
  if (!Array.isArray(tasks)) {
    throw new Error(`task_list did not return metadata.tasks: ${JSON.stringify(response)}`);
  }

  return tasks.map((task) => ({
    id: String((task as { id?: unknown }).id ?? ''),
    subject: String((task as { subject?: unknown }).subject ?? ''),
    status: String((task as { status?: unknown }).status ?? ''),
  }));
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
    const taskSubject = 'release persistence smoke task';
    const seededTurnId = `${created.id}-assistant`;
    const seededCompactMessageId = `${created.id}-compact-summary`;
    const seededTodo: TodoItem = {
      content: 'Verify todo persistence across app-host restart',
      status: 'in_progress',
      activeForm: 'Verifying todo persistence across app-host restart',
    };
    const createdTask = await execDevTool(server, {
      tool: 'task_create',
      sessionId: created.id,
      allowWrite: true,
      params: {
        subject: taskSubject,
        description: 'Verify session-scoped task persistence across app-host restart.',
        priority: 'high',
        metadata: {
          smoke: 'session-persistence',
        },
      },
    });
    const taskId = getCreatedTaskId(createdTask);
    await postRaw(server, '/api/dev/telemetry/seed-turn', {
      sessionId: created.id,
      turnId: seededTurnId,
      title: created.title,
      userPrompt: 'Pin this turn for restart smoke.',
      assistantResponse: 'Pinned response for restart smoke.',
      modelProvider: 'acceptance',
      modelName: 'session-persistence-smoke',
      workingDirectory: process.cwd(),
    });
    const appliedIntervention = await postRaw<ContextInterventionSnapshot>(
      server,
      '/api/context/intervention:set',
      {
        sessionId: created.id,
        messageId: seededTurnId,
        action: 'pin',
        enabled: true,
      },
    );
    if (!appliedIntervention.pinned.includes(seededTurnId)) {
      throw new Error(`Context intervention was not applied before restart: ${JSON.stringify(appliedIntervention)}`);
    }
    const seededTodos = await postRaw<DevTodosResponse>(
      server,
      '/api/dev/todos/seed',
      {
        sessionId: created.id,
        todos: [seededTodo],
      },
    );
    if (!seededTodos.todos.some((todo) => todo.content === seededTodo.content && todo.status === seededTodo.status)) {
      throw new Error(`Todo was not seeded before restart: ${JSON.stringify(seededTodos)}`);
    }
    const seededCompactState = await postRaw<DevCompactStateResponse>(
      server,
      '/api/dev/compact-state/seed',
      {
        sessionId: created.id,
        summaryMessageId: seededCompactMessageId,
        summary: 'Compact state summary for app-host restart smoke.',
        compactedMessageIds: [
          `${created.id}-compact-source-user`,
          `${created.id}-compact-source-assistant`,
        ],
        preservedMessageIds: [seededTurnId],
        anchorMessageId: seededTurnId,
      },
    );
    const seededCompactMessage = seededCompactState.compactionMessages.find((message) => message.id === seededCompactMessageId);
    if (!seededCompactMessage || !seededCompactState.compressionTargetIds.includes(seededCompactMessageId)) {
      throw new Error(`Compact state was not seeded before restart: ${JSON.stringify(seededCompactState)}`);
    }
    await stopServer(server);

    server = await startServer(dataDir);
    const sessions = await api<SessionSummary[]>(server, '/api/sessions');
    const restored = sessions.find((session) => session.id === created.id);
    if (!restored) {
      throw new Error(`Created session ${created.id} was not restored after webServer restart`);
    }

    const listedTasks = getListedTasks(await execDevTool(server, {
      tool: 'task_list',
      sessionId: created.id,
    }));
    const restoredTask = listedTasks.find((task) => task.id === taskId && task.subject === taskSubject);
    if (!restoredTask) {
      throw new Error(`Created task ${taskId} was not restored after webServer restart`);
    }
    const restoredIntervention = await postRaw<ContextInterventionSnapshot>(
      server,
      '/api/context/intervention:get',
      {
        sessionId: created.id,
      },
    );
    if (!restoredIntervention.pinned.includes(seededTurnId)) {
      throw new Error(`Pinned context intervention ${seededTurnId} was not restored after webServer restart`);
    }
    const restoredTodos = await getRaw<DevTodosResponse>(
      server,
      `/api/dev/todos?sessionId=${encodeURIComponent(created.id)}`,
    );
    const restoredTodo = restoredTodos.todos.find((todo) => todo.content === seededTodo.content);
    if (!restoredTodo || restoredTodo.status !== seededTodo.status || restoredTodo.activeForm !== seededTodo.activeForm) {
      throw new Error(`Seeded todo was not restored after webServer restart: ${JSON.stringify(restoredTodos)}`);
    }
    const restoredCompactState = await getRaw<DevCompactStateResponse>(
      server,
      `/api/dev/compact-state?sessionId=${encodeURIComponent(created.id)}`,
    );
    const restoredCompactMessage = restoredCompactState.compactionMessages.find((message) => message.id === seededCompactMessageId);
    if (!restoredCompactMessage) {
      throw new Error(`Compact message ${seededCompactMessageId} was not restored after webServer restart`);
    }
    if (!restoredCompactState.compressionTargetIds.includes(seededCompactMessageId)) {
      throw new Error(`Compression runtime state did not include ${seededCompactMessageId}: ${JSON.stringify(restoredCompactState)}`);
    }
    if (!restoredCompactMessage.preservedMessageIds.includes(seededTurnId)) {
      throw new Error(`Compact survivor manifest did not preserve pinned message ${seededTurnId}: ${JSON.stringify(restoredCompactMessage)}`);
    }
    const restoredReplayState = await getRaw<DevReplayStateResponse>(
      server,
      `/api/dev/replay-state?sessionId=${encodeURIComponent(created.id)}`,
    );
    if (restoredReplayState.replayKey !== created.id) {
      throw new Error(`Replay key was not restored after webServer restart: ${JSON.stringify(restoredReplayState)}`);
    }
    if (restoredReplayState.turnCount < 1) {
      throw new Error(`Structured replay did not include a restored turn: ${JSON.stringify(restoredReplayState)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      dataDir,
      sessionId: created.id,
      restoredTitle: restored.title,
      taskId,
      restoredTaskSubject: restoredTask.subject,
      restoredTaskStatus: restoredTask.status,
      taskCount: listedTasks.length,
      pinnedMessageId: seededTurnId,
      restoredPinnedCount: restoredIntervention.pinned.length,
      restoredTodoContent: restoredTodo.content,
      restoredTodoStatus: restoredTodo.status,
      todoCount: restoredTodos.todos.length,
      compactMessageId: restoredCompactMessage.id,
      compactedMessageCount: restoredCompactMessage.compactedMessageCount,
      compressionCommitCount: restoredCompactState.compressionCommitCount,
      compressionTargetIds: restoredCompactState.compressionTargetIds,
      replayKey: restoredReplayState.replayKey,
      replayDataSource: restoredReplayState.dataSource,
      replayTurnCount: restoredReplayState.turnCount,
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

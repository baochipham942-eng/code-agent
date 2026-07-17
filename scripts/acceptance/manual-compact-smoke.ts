#!/usr/bin/env npx tsx

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'node:stream';
import { access, mkdtemp, rm } from 'fs/promises';
import { constants } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';
import type { Message } from '../../src/shared/contract';
import type { CompactResult } from '../../src/shared/contract/contextHealth';

type ApiResult<T> = {
  success: boolean;
  data?: T;
  error?: { message?: string };
};

type SessionSummary = {
  id: string;
  title: string;
};

type DevTelemetrySeedTurnResponse = {
  ok: boolean;
  sessionId: string;
  turnId: string;
  messageIds: string[];
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
      CODE_AGENT_E2E_LOCAL_COMPACT_MODEL: '1',
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

function longMessage(index: number, role: 'user' | 'assistant'): string {
  const phrase = role === 'user'
    ? `历史片段 ${index}: 用户描述了多轮上下文里的产品状态、运行证据和验收口径。`
    : `历史片段 ${index}: 助手记录了对应的实现判断、验证结果和保留信息。`;
  return Array.from({ length: 240 }, () => phrase).join(' ');
}

async function seedConversation(server: StartedServer, sessionId: string): Promise<string[]> {
  const messageIds: string[] = [];
  for (let index = 1; index <= 9; index += 1) {
    const turnId = `${sessionId}-turn-${index}`;
    const seeded = await postRaw<DevTelemetrySeedTurnResponse>(
      server,
      '/api/dev/telemetry/seed-turn',
      {
        sessionId,
        turnId,
        title: 'Manual compact app-host smoke',
        userPrompt: longMessage(index, 'user'),
        assistantResponse: longMessage(index, 'assistant'),
        modelProvider: 'acceptance',
        modelName: 'manual-compact-seed',
        workingDirectory: process.cwd(),
      },
    );
    if (!seeded.ok || seeded.sessionId !== sessionId || seeded.turnId !== turnId) {
      throw new Error(`Seed turn failed: ${JSON.stringify(seeded)}`);
    }
    messageIds.push(...seeded.messageIds);
  }
  return messageIds;
}

async function main(): Promise<void> {
  await ensureBuiltWebServer();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-manual-compact-smoke-'));
  let server: StartedServer | null = null;

  try {
    server = await startServer(dataDir);
    const created = await api<SessionSummary>(server, '/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Manual compact app-host smoke',
        workingDirectory: process.cwd(),
      }),
    });
    const seededMessageIds = await seedConversation(server, created.id);
    const beforeMessages = await api<Message[]>(
      server,
      `/api/sessions/${encodeURIComponent(created.id)}/messages`,
    );
    if (beforeMessages.length !== seededMessageIds.length) {
      throw new Error(`Seeded message count mismatch: ${beforeMessages.length} vs ${seededMessageIds.length}`);
    }

    const compact = await postRaw<CompactResult>(
      server,
      '/api/context/compact-current',
      [created.id],
    );
    if (!compact.success || !compact.summaryMessageId) {
      throw new Error(`Manual compact did not succeed: ${JSON.stringify(compact)}`);
    }
    if (compact.provider !== 'acceptance' || compact.model !== 'e2e-local-compact-model') {
      throw new Error(`Manual compact did not use the E2E compact model boundary: ${JSON.stringify(compact)}`);
    }
    if (compact.savedTokens <= 0 || compact.afterTokens >= compact.beforeTokens) {
      throw new Error(`Manual compact did not reduce context tokens: ${JSON.stringify(compact)}`);
    }

    const afterMessages = await api<Message[]>(
      server,
      `/api/sessions/${encodeURIComponent(created.id)}/messages`,
    );
    const summaryMessage = afterMessages.find((message) => message.id === compact.summaryMessageId);
    if (!summaryMessage?.compaction || summaryMessage.compaction.provider !== 'acceptance') {
      throw new Error(`Persisted messages do not include the compact summary block: ${JSON.stringify(afterMessages)}`);
    }
    if (!summaryMessage.content.includes('E2E local compact summary')) {
      throw new Error(`Persisted compact summary did not come from the E2E compact model: ${summaryMessage.content}`);
    }

    const compactState = await getRaw<DevCompactStateResponse>(
      server,
      `/api/dev/compact-state?sessionId=${encodeURIComponent(created.id)}`,
    );
    if (!compactState.compressionTargetIds.includes(compact.summaryMessageId)) {
      throw new Error(`Compression runtime state did not target compact summary: ${JSON.stringify(compactState)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      dataDir,
      sessionId: created.id,
      seededMessageCount: seededMessageIds.length,
      beforeMessageCount: beforeMessages.length,
      afterMessageCount: afterMessages.length,
      summaryMessageId: compact.summaryMessageId,
      compactedMessageCount: compact.compactedMessageCount,
      preservedMessageCount: compact.preservedMessageCount,
      beforeTokens: compact.beforeTokens,
      afterTokens: compact.afterTokens,
      savedTokens: compact.savedTokens,
      provider: compact.provider,
      model: compact.model,
      compressionCommitCount: compactState.compressionCommitCount,
      compressionTargetIds: compactState.compressionTargetIds,
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

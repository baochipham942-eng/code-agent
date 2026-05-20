import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionsRouter } from '../../../src/web/routes/sessions';
import { inMemorySessions, sessionMessages } from '../../../src/web/helpers/sessionCache';

interface SessionApiBody {
  success: boolean;
  data?: {
    id: string;
    title?: string;
    workingDirectory?: string;
  };
  error?: {
    message?: string;
  };
}

let server: http.Server | undefined;
let baseUrl = '';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function startSessionsApi(deps: {
  tryGetSessionManager: () => Promise<unknown>;
  getSupabaseForSession?: () => Promise<unknown>;
}) {
  const app = express();
  app.use(express.json());
  app.use('/api', createSessionsRouter({
    logger,
    tryGetSessionManager: deps.tryGetSessionManager,
    getSupabaseForSession: deps.getSupabaseForSession ?? (async () => null),
    activeAgentLoops: new Map(),
  }));

  server = await new Promise<http.Server>((resolve) => {
    const nextServer = app.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function closeServer() {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
  baseUrl = '';
}

async function postSession(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<SessionApiBody>;
}

async function postSessionRaw(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as SessionApiBody,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  inMemorySessions.clear();
  sessionMessages.clear();
});

afterEach(async () => {
  await closeServer();
  inMemorySessions.clear();
  sessionMessages.clear();
});

describe('createSessionsRouter', () => {
  it('passes workingDirectory through to SessionManager when creating a session', async () => {
    const createSession = vi.fn(async (options: { title: string; workingDirectory?: string }) => ({
      id: 'session-sm',
      title: options.title,
      workingDirectory: options.workingDirectory,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    }));
    const setCurrentSession = vi.fn();

    await startSessionsApi({
      tryGetSessionManager: async () => ({
        getCurrentSessionId: vi.fn(() => null),
        createSession,
        setCurrentSession,
      }),
    });

    const body = await postSession({
      title: 'Workbench',
      workingDirectory: '  /Users/linchen/Downloads/ai/code-agent  ',
    });

    expect(body.success).toBe(true);
    expect(body.data.workingDirectory).toBe('/Users/linchen/Downloads/ai/code-agent');
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Workbench',
      workingDirectory: '/Users/linchen/Downloads/ai/code-agent',
    }));
    expect(setCurrentSession).toHaveBeenCalledWith('session-sm');
  });

  it('keeps workingDirectory in the in-memory fallback path', async () => {
    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => null,
    });

    const body = await postSession({
      title: 'Memory fallback',
      workingDirectory: '/tmp/void-harbor',
    });

    expect(body.success).toBe(true);
    expect(body.data.title).toBe('Memory fallback');
    expect(body.data.workingDirectory).toBe('/tmp/void-harbor');
    expect(inMemorySessions.get(body.data.id)?.workingDirectory).toBe('/tmp/void-harbor');
  });

  it('rejects malformed create-session bodies before calling dependencies', async () => {
    const tryGetSessionManager = vi.fn(async () => null);
    const getSupabaseForSession = vi.fn(async () => null);
    await startSessionsApi({
      tryGetSessionManager,
      getSupabaseForSession,
    });

    const result = await postSessionRaw({
      title: 42,
      workingDirectory: '/tmp/void-harbor',
    });

    expect(result.status).toBe(400);
    expect(result.body.success).toBe(false);
    expect(result.body.error?.message).toContain('Expected string');
    expect(tryGetSessionManager).not.toHaveBeenCalled();
    expect(getSupabaseForSession).not.toHaveBeenCalled();
  });
});

// ============================================================================
// sessions 路由失败路径：不存在的 session id、内存降级 NOT_FOUND、archive 空结果。
// sessionsRouter.test.ts 侧重 happy path / Supabase soft-delete，缺口补在这里。
// ============================================================================
import express from 'express';
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionsRouter } from '../../../src/web/routes/sessions';
import {
  inMemorySessionsProjection as inMemorySessions,
  sessionMessagesProjection as sessionMessages,
} from '../../../src/web/helpers/webSessionStore';

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
    tryGetSessionManager: deps.tryGetSessionManager as () => Promise<null>,
    getSupabaseForSession: (deps.getSupabaseForSession ?? (async () => null)) as () => Promise<null>,
  }));

  server = await new Promise<http.Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
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

describe('createSessionsRouter — missing session failure paths', () => {
  it('returns NOT_FOUND for unknown session id on memory fallback', async () => {
    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => null,
    });

    const response = await fetch(`${baseUrl}/api/sessions/does-not-exist`);
    const body = await response.json();

    expect(body).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Session does-not-exist not found',
      },
    });
  });

  it('falls through SessionManager null restore to memory NOT_FOUND', async () => {
    const restoreSession = vi.fn(async () => null);
    await startSessionsApi({
      tryGetSessionManager: async () => ({ restoreSession }),
      getSupabaseForSession: async () => null,
    });

    const response = await fetch(`${baseUrl}/api/sessions/missing-from-sm`);
    const body = await response.json();

    expect(restoreSession).toHaveBeenCalledWith('missing-from-sm');
    expect(body.success).toBe(false);
    expect(body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('missing-from-sm'),
    });
  });

  it('returns empty messages array for unknown session id (memory path)', async () => {
    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => null,
    });

    const response = await fetch(`${baseUrl}/api/sessions/ghost/messages`);
    const body = await response.json();

    expect(body).toEqual({ success: true, data: [] });
  });

  it('archive of unknown memory session returns success with null data', async () => {
    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => null,
    });

    const response = await fetch(`${baseUrl}/api/sessions/ghost/archive`, { method: 'POST' });
    const body = await response.json();

    expect(body).toEqual({ success: true, data: null });
  });

  it('DELETE unknown memory session still reports success after projection clear', async () => {
    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => null,
    });

    const response = await fetch(`${baseUrl}/api/sessions/ghost`, { method: 'DELETE' });
    const body = await response.json();

    expect(body).toEqual({ success: true, data: null });
    expect(inMemorySessions.has('ghost')).toBe(false);
  });

  it('propagates SessionManager list failures as DB_ERROR without throwing', async () => {
    await startSessionsApi({
      tryGetSessionManager: async () => ({
        listSessions: async () => {
          throw new Error('list boom');
        },
      }),
    });

    const response = await fetch(`${baseUrl}/api/sessions`);
    const body = await response.json();

    expect(body).toEqual({
      success: false,
      error: { code: 'DB_ERROR', message: 'list boom' },
    });
    expect(logger.error).toHaveBeenCalled();
  });
});

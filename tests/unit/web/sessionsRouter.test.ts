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
    messages?: Array<{
      id: string;
      role: string;
      content: string;
      timestamp: number;
      toolCalls?: unknown[];
    }>;
    isArchived?: boolean;
    archivedAt?: number;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

interface QueryCallLog {
  select: Array<string | undefined>;
  eq: Array<[string, unknown]>;
  order: Array<[string, { ascending: boolean }]>;
  insert: Array<Record<string, unknown>>;
  update: Array<Record<string, unknown>>;
  limit: number[];
}

function createSupabaseQuery<T>(
  result: { data: T[] | null; error: unknown } = { data: [], error: null },
  singleResult?: { data: T | null; error: unknown },
) {
  const calls: QueryCallLog = {
    select: [],
    eq: [],
    order: [],
    insert: [],
    update: [],
    limit: [],
  };
  const query = {
    calls,
    select: vi.fn((columns?: string) => {
      calls.select.push(columns);
      return query;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      calls.eq.push([column, value]);
      return query;
    }),
    order: vi.fn((column: string, options: { ascending: boolean }) => {
      calls.order.push([column, options]);
      return query;
    }),
    insert: vi.fn((value: Record<string, unknown>) => {
      calls.insert.push(value);
      return query;
    }),
    update: vi.fn((value: Record<string, unknown>) => {
      calls.update.push(value);
      return query;
    }),
    limit: vi.fn((count: number) => {
      calls.limit.push(count);
      return query;
    }),
    single: vi.fn(async () => singleResult ?? {
      data: result.data?.[0] ?? null,
      error: result.error,
    }),
    then: (
      onFulfilled?: ((value: { data: T[] | null; error: unknown }) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return query;
}

function createSupabaseClient(queries: Record<string, ReturnType<typeof createSupabaseQuery> | Array<ReturnType<typeof createSupabaseQuery>>>) {
  const from = vi.fn((table: string) => {
    const queryOrQueue = queries[table];
    if (Array.isArray(queryOrQueue)) {
      const next = queryOrQueue.shift();
      if (!next) throw new Error(`No Supabase query left for table ${table}`);
      return next;
    }
    if (!queryOrQueue) throw new Error(`No Supabase query configured for table ${table}`);
    return queryOrQueue;
  });
  return {
    supabase: { from },
    from,
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

async function fetchJson(pathname: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
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
  it('passes includeArchived to SessionManager when listing sessions', async () => {
    const listSessions = vi.fn(async () => [
      { id: 'archived-session', title: 'Archived' },
    ]);

    await startSessionsApi({
      tryGetSessionManager: async () => ({ listSessions }),
    });

    const result = await fetchJson('/api/sessions?includeArchived=true');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      success: true,
      data: [{ id: 'archived-session', title: 'Archived' }],
    });
    expect(listSessions).toHaveBeenCalledWith({ includeArchived: true });
  });

  it('lists in-memory sessions sorted by recency and filters archived sessions by default', async () => {
    inMemorySessions.set('old', {
      id: 'old',
      title: 'Old',
      createdAt: 1,
      updatedAt: 10,
      messageCount: 0,
    });
    inMemorySessions.set('archived', {
      id: 'archived',
      title: 'Archived',
      createdAt: 2,
      updatedAt: 30,
      messageCount: 0,
      isArchived: true,
    });
    inMemorySessions.set('new', {
      id: 'new',
      title: 'New',
      createdAt: 3,
      updatedAt: 20,
      messageCount: 0,
    });

    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => null,
    });

    const activeOnly = await fetchJson('/api/sessions');
    const includeArchived = await fetchJson('/api/sessions?includeArchived=true');

    expect(activeOnly.body.success).toBe(true);
    expect((activeOnly.body.data as unknown[]).map((session: any) => session.id)).toEqual(['new', 'old']);
    expect((includeArchived.body.data as unknown[]).map((session: any) => session.id)).toEqual(['archived', 'new', 'old']);
  });

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
    // zod 4 错误信息格式：'Invalid input: expected string, received number'（v3 为 'Expected string'）
    expect(result.body.error?.message).toContain('expected string');
    expect(tryGetSessionManager).not.toHaveBeenCalled();
    expect(getSupabaseForSession).not.toHaveBeenCalled();
  });

  it('fills empty SessionManager restores from cached messages while preserving tool calls', async () => {
    sessionMessages.set('session-db', [{
      id: 'msg-1',
      role: 'assistant',
      content: '',
      timestamp: 123,
      toolCalls: [{
        id: 'tool-1',
        name: 'read_file',
        result: { success: true, output: 'ok' },
      }],
    }]);
    const restoreSession = vi.fn(async () => ({
      id: 'session-db',
      title: 'DB session',
      createdAt: 1,
      updatedAt: 2,
      messageCount: 0,
      messages: [],
    }));

    await startSessionsApi({
      tryGetSessionManager: async () => ({ restoreSession }),
    });

    const result = await fetchJson('/api/sessions/session-db');

    expect(result.body.success).toBe(true);
    expect(result.body.data?.messages).toEqual([{
      id: 'msg-1',
      role: 'assistant',
      content: '',
      timestamp: 123,
      toolCalls: [{
        id: 'tool-1',
        name: 'read_file',
        result: { success: true, output: 'ok' },
      }],
    }]);
    expect(logger.info).toHaveBeenCalledWith(
      'GET /api/sessions/:id — DB messages empty, falling back to in-memory cache',
      { sessionId: 'session-db', memCount: 1 },
    );
  });

  it('preserves cached tool calls in the in-memory messages endpoint', async () => {
    sessionMessages.set('session-memory', [{
      id: 'msg-1',
      role: 'assistant',
      content: '',
      timestamp: 123,
      toolCalls: [{
        id: 'tool-1',
        name: 'shell',
        result: { success: true, output: 'done' },
      }],
    }]);

    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => null,
    });

    const result = await fetchJson('/api/sessions/session-memory/messages');

    expect(result.body).toEqual({
      success: true,
      data: [{
        id: 'msg-1',
        role: 'assistant',
        content: '',
        timestamp: 123,
        toolCalls: [{
          id: 'tool-1',
          name: 'shell',
          result: { success: true, output: 'done' },
        }],
      }],
    });
  });

  // 工单行为不变清单 #4/#10：内存降级的列表和 messages endpoint 保持现有返回形状与富字段。
  it('returns the current in-memory session list and rich message response shapes', async () => {
    inMemorySessions.set('session-shape', {
      id: 'session-shape',
      title: 'Shape baseline',
      createdAt: 10,
      updatedAt: 20,
      messageCount: 1,
    });
    sessionMessages.set('session-shape', [{
      id: 'message-shape',
      role: 'assistant',
      content: 'shape answer',
      timestamp: 30,
      thinking: 'shape thinking',
      contentParts: [{ type: 'text', text: 'shape answer' }],
      artifacts: [{
        id: 'artifact-shape',
        type: 'chart',
        content: '{"title":"Shape"}',
        title: 'Shape',
        version: 1,
      }],
      attachments: [{
        id: 'attachment-shape',
        type: 'file',
        category: 'text',
        name: 'shape.txt',
        size: 5,
        mimeType: 'text/plain',
        data: 'shape',
      }],
      metadata: {
        turnQuality: {
          capabilities: { agentId: 'explore', agentName: 'Explorer' },
        },
      },
    }]);

    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => null,
    });

    const list = await fetchJson('/api/sessions');
    const messages = await fetchJson('/api/sessions/session-shape/messages');

    expect(list.body).toEqual({
      success: true,
      data: [{
        id: 'session-shape',
        title: 'Shape baseline',
        createdAt: 10,
        updatedAt: 20,
        messageCount: 1,
      }],
    });
    expect(messages.body).toEqual({
      success: true,
      data: [{
        ...sessionMessages.get('session-shape')![0],
        toolCalls: [],
      }],
    });
  });

  it('loads Supabase sessions with messages and applies user plus deleted filters', async () => {
    const sessionQuery = createSupabaseQuery(
      { data: [], error: null },
      { data: { id: 'session-sb', title: 'Cloud session' }, error: null },
    );
    const messagesQuery = createSupabaseQuery({
      data: [{
        id: 'msg-sb',
        role: 'assistant',
        content: 'Cloud answer',
        timestamp: 456,
        tool_calls: [{
          id: 'tool-sb',
          name: 'search',
        }],
      }],
      error: null,
    });
    const { supabase } = createSupabaseClient({
      sessions: sessionQuery,
      messages: messagesQuery,
    });

    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => ({ supabase, userId: 'user-1' }),
    });

    const result = await fetchJson('/api/sessions/session-sb');

    expect(result.body).toEqual({
      success: true,
      data: {
        id: 'session-sb',
        title: 'Cloud session',
        messages: [{
          id: 'msg-sb',
          role: 'assistant',
          content: 'Cloud answer',
          timestamp: 456,
          toolCalls: [{
            id: 'tool-sb',
            name: 'search',
          }],
        }],
        todos: [],
      },
    });
    expect(sessionQuery.calls.eq).toEqual([
      ['id', 'session-sb'],
      ['user_id', 'user-1'],
      ['is_deleted', false],
    ]);
    expect(messagesQuery.calls.eq).toEqual([
      ['session_id', 'session-sb'],
      ['is_deleted', false],
    ]);
    expect(messagesQuery.calls.order).toEqual([
      ['timestamp', { ascending: true }],
    ]);
  });

  it('applies Supabase message limits and maps tool calls in the messages endpoint', async () => {
    const messagesQuery = createSupabaseQuery({
      data: [{
        id: 'msg-limited',
        role: 'assistant',
        content: 'Limited answer',
        timestamp: 789,
        tool_calls: [{
          id: 'tool-limited',
          name: 'grep',
        }],
      }],
      error: null,
    });
    const { supabase } = createSupabaseClient({ messages: messagesQuery });

    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => ({ supabase, userId: 'user-1' }),
    });

    const result = await fetchJson('/api/sessions/session-sb/messages?limit=1');

    expect(result.body).toEqual({
      success: true,
      data: [{
        id: 'msg-limited',
        role: 'assistant',
        content: 'Limited answer',
        timestamp: 789,
        toolCalls: [{
          id: 'tool-limited',
          name: 'grep',
        }],
      }],
    });
    expect(messagesQuery.calls.limit).toEqual([1]);
  });

  it('soft deletes Supabase sessions and messages before clearing in-memory cache', async () => {
    inMemorySessions.set('session-delete', {
      id: 'session-delete',
      title: 'Delete me',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 1,
    });
    sessionMessages.set('session-delete', [{
      id: 'msg-delete',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    }]);
    const sessionDeleteQuery = createSupabaseQuery({ data: [], error: null });
    const messageDeleteQuery = createSupabaseQuery({ data: [], error: null });
    const { supabase } = createSupabaseClient({
      sessions: sessionDeleteQuery,
      messages: messageDeleteQuery,
    });

    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => ({ supabase, userId: 'user-1' }),
    });

    const result = await fetchJson('/api/sessions/session-delete', { method: 'DELETE' });

    expect(result.body).toEqual({ success: true, data: null });
    expect(sessionDeleteQuery.calls.update[0]).toEqual(expect.objectContaining({ is_deleted: true }));
    expect(sessionDeleteQuery.calls.eq).toEqual([
      ['id', 'session-delete'],
      ['user_id', 'user-1'],
    ]);
    expect(messageDeleteQuery.calls.update[0]).toEqual(expect.objectContaining({ is_deleted: true }));
    expect(messageDeleteQuery.calls.eq).toEqual([
      ['session_id', 'session-delete'],
      ['user_id', 'user-1'],
    ]);
    expect(inMemorySessions.has('session-delete')).toBe(false);
    expect(sessionMessages.has('session-delete')).toBe(false);
  });

  it('reports Supabase soft delete errors instead of clearing local caches as success', async () => {
    inMemorySessions.set('session-delete', {
      id: 'session-delete',
      title: 'Delete me',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    });
    const sessionDeleteQuery = createSupabaseQuery({ data: null, error: new Error('delete denied') });
    const { supabase } = createSupabaseClient({
      sessions: sessionDeleteQuery,
    });

    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => ({ supabase, userId: 'user-1' }),
    });

    const result = await fetchJson('/api/sessions/session-delete', { method: 'DELETE' });

    expect(result.body.success).toBe(false);
    expect(result.body.error).toEqual({
      code: 'DB_ERROR',
      message: 'delete denied',
    });
    expect(inMemorySessions.has('session-delete')).toBe(true);
  });

  it('archives and unarchives in-memory sessions', async () => {
    inMemorySessions.set('session-archive', {
      id: 'session-archive',
      title: 'Archive me',
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
    });

    await startSessionsApi({
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => null,
    });

    const archived = await fetchJson('/api/sessions/session-archive/archive', { method: 'POST' });
    const archivedAt = archived.body.data?.archivedAt;
    const unarchived = await fetchJson('/api/sessions/session-archive/unarchive', { method: 'POST' });

    expect(archived.body.data?.isArchived).toBe(true);
    expect(archivedAt).toEqual(expect.any(Number));
    expect(unarchived.body.data?.isArchived).toBe(false);
    expect(unarchived.body.data?.archivedAt).toBeUndefined();
  });
});

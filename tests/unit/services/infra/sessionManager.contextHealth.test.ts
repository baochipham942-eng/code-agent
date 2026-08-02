import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  messages: new Map<string, any[]>(),
}));

const database = vi.hoisted(() => ({
  getSession: vi.fn((sessionId: string) => ({
    id: sessionId,
    userId: null,
    title: 'Session',
    modelConfig: { provider: 'openai', model: 'gpt-5.5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: state.messages.get(sessionId)?.length ?? 0,
    turnCount: state.messages.get(sessionId)?.filter((message) => message.role === 'user').length ?? 0,
  })),
  getDb: vi.fn(() => null),
  getRecentMessages: vi.fn((sessionId: string, messageLimit: number) => (
    (state.messages.get(sessionId) ?? []).slice(-messageLimit)
  )),
  getTodos: vi.fn(() => []),
  replaceMessages: vi.fn((sessionId: string, messages: any[]) => {
    state.messages.set(sessionId, messages);
  }),
}));

vi.mock('../../../../src/host/services/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/host/services/core')>(),
  getDatabase: () => database,
}));

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => database,
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => false,
  getSupabase: () => null,
}));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn() }),
}));

import { getContextHealthService } from '../../../../src/host/context/contextHealthService';
import { resolveContextHealthForSession } from '../../../../src/host/ipc/contextHealth.ipc';
import { SessionManager } from '../../../../src/host/services/infra/sessionManager';

function messages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `message ${index + 1}`,
    timestamp: index + 1,
  }));
}

describe('SessionManager cache messageLimit hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.messages.clear();
  });

  it('reloads the full history after a one-message cache fill', async () => {
    const sessionId = 'full-history-after-short-cache';
    const persistedMessages = messages(100);
    state.messages.set(sessionId, persistedMessages);
    const manager = new SessionManager();

    expect((await manager.getSession(sessionId, 1))?.messages).toHaveLength(1);
    const fullSession = await manager.getSession(sessionId, Number.MAX_SAFE_INTEGER);

    expect(fullSession?.messages).toHaveLength(100);
    expect(fullSession?.messages.at(0)?.id).toBe('message-1');
    expect(fullSession?.messages.at(-1)?.id).toBe('message-100');
    expect(database.getRecentMessages).toHaveBeenNthCalledWith(2, sessionId, Number.MAX_SAFE_INTEGER);
  });

  it('reloads 80 messages after a one-message cache fill', async () => {
    const sessionId = 'neo-tag-history-after-short-cache';
    const persistedMessages = messages(100);
    state.messages.set(sessionId, persistedMessages);
    const manager = new SessionManager();

    expect((await manager.getSession(sessionId, 1))?.messages).toHaveLength(1);
    const expandedSession = await manager.getSession(sessionId, 80);

    expect(expandedSession?.messages).toHaveLength(80);
    expect(expandedSession?.messages.at(0)?.id).toBe('message-21');
    expect(expandedSession?.messages.at(-1)?.id).toBe('message-100');
    expect(database.getRecentMessages).toHaveBeenNthCalledWith(2, sessionId, 80);
  });

  it('does not reload when the session has fewer messages than the requested limit', async () => {
    const sessionId = 'short-complete-history';
    const persistedMessages = messages(3);
    state.messages.set(sessionId, persistedMessages);
    const manager = new SessionManager();

    expect((await manager.getSession(sessionId, 80))?.messages).toEqual(persistedMessages);
    expect((await manager.getSession(sessionId, 80))?.messages).toEqual(persistedMessages);

    expect(database.getRecentMessages).toHaveBeenCalledTimes(1);
  });
});

describe('SessionManager context health invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.messages.clear();
    getContextHealthService().clear();
  });

  it('invalidates health when replaceMessages removes persisted history', async () => {
    const sessionId = 'replace-messages-session';
    const replacement = [{
      id: 'summary',
      role: 'assistant' as const,
      content: '压缩后的短摘要',
      timestamp: 2,
    }];
    const stale = getContextHealthService().update(
      sessionId,
      [{ role: 'user', content: '即将被删除的长历史'.repeat(500) }],
      '',
      'gpt-5.5',
    );
    const manager = new SessionManager();

    await manager.replaceMessages(sessionId, replacement);
    const refreshed = await resolveContextHealthForSession({
      getAppService: () => ({
        getMessages: async () => state.messages.get(sessionId) ?? [],
        getModelOverride: () => undefined,
      }) as never,
    }, sessionId);

    expect(refreshed.currentTokens).toBeLessThan(stale.currentTokens);
    expect(refreshed.breakdown.messages).toBeGreaterThan(0);
  });
});

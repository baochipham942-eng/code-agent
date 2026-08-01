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
  })),
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

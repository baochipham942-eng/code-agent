import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HandlerFn } from '../../../src/host/platform';
import type { Message } from '../../../src/shared/contract';
import { installSessionDomainHandler } from '../../../src/web/sessionDomainHandler';
import {
  createWebSessionStore,
  sessionMessagesProjection,
} from '../../../src/web/helpers/webSessionStore';

const mocks = vi.hoisted(() => ({
  rewindConversation: vi.fn(),
  restoreConversation: vi.fn(),
  invalidateSessionCache: vi.fn(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({}),
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    invalidateSessionCache: mocks.invalidateSessionCache,
  }),
}));

vi.mock('../../../src/host/services/sessionRewind/SessionRewindService', () => ({
  SessionRewindService: class {
    rewindConversation(...args: unknown[]) {
      return mocks.rewindConversation(...args);
    }

    restoreConversation(...args: unknown[]) {
      return mocks.restoreConversation(...args);
    }
  },
}));

type DomainResponse = {
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
};

function installHandler(): HandlerFn {
  const handlers = new Map<string, HandlerFn>();
  installSessionDomainHandler({
    handlers,
    getDbAvailable: () => true,
    hasActiveRun: () => false,
    getCurrentSessionId: () => null,
    setCurrentSessionId: vi.fn(),
    getDurableRunReadService: () => undefined,
  });
  const handler = handlers.get('domain:session');
  if (!handler) throw new Error('domain:session handler was not installed');
  return handler;
}

function cachedHistory(): Message[] {
  return [
    { id: 'u1', role: 'user', content: 'one', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'one answer', timestamp: 2 },
    { id: 'u2', role: 'user', content: 'two', timestamp: 3 },
    { id: 'a2', role: 'assistant', content: 'two answer', timestamp: 4 },
  ];
}

describe('Web session Rewind projection parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMessagesProjection.clear();
    mocks.rewindConversation.mockResolvedValue({
      rewindId: 'rewind-1',
      activeMessages: cachedHistory().slice(0, 2),
    });
    mocks.restoreConversation.mockResolvedValue({
      rewindId: 'rewind-1',
      activeMessages: cachedHistory(),
    });
  });

  it('invalidates both caches so the next run hydrates only the visible Rewind prefix', async () => {
    sessionMessagesProjection.set('session-1', cachedHistory());
    const handler = installHandler();

    const response = await handler({}, {
      action: 'rewindConversation',
      payload: {
        sessionId: 'session-1',
        anchorUserMessageId: 'u2',
        idempotencyKey: 'rewind-key',
      },
    }) as DomainResponse;

    expect(response.success).toBe(true);
    expect(mocks.invalidateSessionCache).toHaveBeenCalledWith('session-1');
    expect(sessionMessagesProjection.has('session-1')).toBe(false);

    const getMessages = vi.fn(async () => cachedHistory().slice(0, 2));
    const store = createWebSessionStore({
      tryGetSessionManager: async () => ({ getMessages }),
      getDatabase: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await expect(store.loadSessionHistoryForRun('session-1'))
      .resolves.toMatchObject([{ id: 'u1' }, { id: 'a1' }]);
    expect(getMessages).toHaveBeenCalledWith('session-1');
  });

  it('invalidates both caches after recovery so the next run reloads the restored suffix', async () => {
    sessionMessagesProjection.set('session-1', cachedHistory().slice(0, 2));
    const handler = installHandler();

    const response = await handler({}, {
      action: 'restoreConversationRewind',
      payload: {
        sessionId: 'session-1',
        rewindId: 'rewind-1',
      },
    }) as DomainResponse;

    expect(response.success).toBe(true);
    expect(mocks.invalidateSessionCache).toHaveBeenCalledWith('session-1');
    expect(sessionMessagesProjection.has('session-1')).toBe(false);

    const getMessages = vi.fn(async () => cachedHistory());
    const store = createWebSessionStore({
      tryGetSessionManager: async () => ({ getMessages }),
      getDatabase: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await expect(store.loadSessionHistoryForRun('session-1'))
      .resolves.toHaveLength(4);
  });

  it('keeps the existing projection when Rewind fails before committing', async () => {
    sessionMessagesProjection.set('session-1', cachedHistory());
    mocks.rewindConversation.mockRejectedValue(
      Object.assign(new Error('SESSION_RUNNING'), { code: 'SESSION_RUNNING' }),
    );
    const handler = installHandler();

    const response = await handler({}, {
      action: 'rewindConversation',
      payload: {
        sessionId: 'session-1',
        anchorUserMessageId: 'u2',
        idempotencyKey: 'rewind-key',
      },
    }) as DomainResponse;

    expect(response).toMatchObject({
      success: false,
      error: { code: 'SESSION_RUNNING' },
    });
    expect(mocks.invalidateSessionCache).not.toHaveBeenCalled();
    expect(sessionMessagesProjection.has('session-1')).toBe(true);
  });
});

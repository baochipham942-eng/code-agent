import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentApplicationService } from '../../../src/shared/contract/appService';

const mocks = vi.hoisted(() => ({
  database: {
    isReady: true,
    getMessages: vi.fn(),
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => mocks.database,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
  logger: mocks.logger,
}));

import { performCrossSessionSearch } from '../../../src/host/ipc/session.ipc';
import { getDefaultCache } from '../../../src/host/session/localCache';

function createAppService(
  sessions: Array<{ id: string; title: string }> = [],
): () => AgentApplicationService {
  return () => ({
    listSessions: vi.fn().mockResolvedValue(sessions),
  }) as unknown as AgentApplicationService;
}

describe('cross-session search hydration', () => {
  beforeEach(() => {
    getDefaultCache().clear();
    mocks.database.isReady = true;
    mocks.database.getMessages.mockReset();
    mocks.logger.warn.mockReset();
  });

  it('finds a body-only match after hydrating the requested session from the database', async () => {
    mocks.database.getMessages.mockReturnValue([
      {
        id: 'message-body-hit',
        role: 'assistant',
        content: 'The persisted transcript contains needle-body-only here.',
        timestamp: 10,
      },
    ]);

    const result = await performCrossSessionSearch(
      'needle-body-only',
      { sessionIds: ['session-body-hit'] },
      createAppService([
        { id: 'session-body-hit', title: 'A title without the search term' },
      ]),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      sessionId: 'session-body-hit',
      sessionTitle: 'A title without the search term',
      messageId: 'message-body-hit',
    });
    expect(result.results[0].snippet).toContain('needle-body-only');
  });

  it('does not read messages again when the requested session is already cached', async () => {
    getDefaultCache().setSession({
      sessionId: 'session-cached',
      messages: [{
        id: 'cached-message',
        role: 'user',
        content: 'cached needle',
        timestamp: 20,
      }],
      startedAt: 20,
      lastActivityAt: 20,
      totalTokens: 0,
    });

    const result = await performCrossSessionSearch(
      'cached needle',
      { sessionIds: ['session-cached'] },
      createAppService(),
    );

    expect(mocks.database.getMessages).not.toHaveBeenCalled();
    expect(result.results.map((item) => item.messageId)).toEqual(['cached-message']);
  });

  it('caps each database hydration read at 500 messages', async () => {
    mocks.database.getMessages.mockReturnValue([]);

    await performCrossSessionSearch(
      'needle',
      { sessionIds: ['session-bounded'] },
      createAppService(),
    );

    expect(mocks.database.getMessages).toHaveBeenCalledTimes(1);
    expect(mocks.database.getMessages).toHaveBeenCalledWith('session-bounded', 500);
  });

  it('skips a failed session read while returning matches from other requested sessions', async () => {
    mocks.database.getMessages.mockImplementation((sessionId: string) => {
      if (sessionId === 'session-failed') {
        throw new Error('database read failed');
      }
      return [{
        id: 'message-survives',
        role: 'user',
        content: 'resilient needle remains searchable',
        timestamp: 30,
      }];
    });

    const result = await performCrossSessionSearch(
      'resilient needle',
      { sessionIds: ['session-failed', 'session-healthy'] },
      createAppService(),
    );

    expect(result.results.map((item) => item.messageId)).toEqual(['message-survives']);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Failed to hydrate session for cross-session search',
      expect.objectContaining({
        sessionId: 'session-failed',
        error: expect.any(Error),
      }),
    );
  });

  it('skips scoped hydration and logs when the database is not ready', async () => {
    mocks.database.isReady = false;

    const result = await performCrossSessionSearch(
      'needle',
      { sessionIds: ['session-db-not-ready'] },
      createAppService(),
    );

    expect(mocks.database.getMessages).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Skipping cross-session search hydration because database is not ready',
      { sessionIds: ['session-db-not-ready'] },
    );
  });

  it('does not hydrate from the database when sessionIds are omitted', async () => {
    getDefaultCache().setSession({
      sessionId: 'session-cache-only',
      messages: [{
        id: 'cache-only-message',
        role: 'assistant',
        content: 'cache-only needle',
        timestamp: 40,
      }],
      startedAt: 40,
      lastActivityAt: 40,
      totalTokens: 0,
    });

    const result = await performCrossSessionSearch(
      'cache-only needle',
      undefined,
      createAppService(),
    );

    expect(mocks.database.getMessages).not.toHaveBeenCalled();
    expect(result.results.map((item) => item.messageId)).toEqual(['cache-only-message']);
  });
});

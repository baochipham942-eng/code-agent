import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: string; email: string; isAdmin?: boolean },
  sessionVerified: false,
  db: {
    getStats: vi.fn(),
    getSnapshotStats: vi.fn(),
    getCompactionStats: vi.fn(),
    getPreference: vi.fn(),
    getToolCacheCount: vi.fn(),
    getLocalCacheStats: vi.fn(),
    clearToolCache: vi.fn(),
    clearAllMessages: vi.fn(),
    clearAllSessions: vi.fn(),
  },
  getDatabase: vi.fn(),
  toolCache: {
    getStats: vi.fn(),
    clear: vi.fn(),
  },
  sessionManager: {
    clearCache: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/auth', () => ({
  getAuthService: () => ({
    getCurrentUser: () => mocks.currentUser,
    hasVerifiedSession: () => mocks.sessionVerified,
  }),
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: mocks.getDatabase,
}));

vi.mock('../../../src/main/services/infra/toolCache', () => ({
  getToolCache: () => mocks.toolCache,
}));

vi.mock('../../../src/main/services/infra/sessionManager', () => ({
  getSessionManager: () => mocks.sessionManager,
}));

vi.mock('../../../src/main/platform', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/code-agent-test'),
  },
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { registerDataHandlers } from '../../../src/main/ipc/data.ipc';

type DomainHandler = (_: unknown, request: IPCRequest) => Promise<IPCResponse>;

function makeFakeIpc(): { handle: Mock; getHandler: () => DomainHandler } {
  const registry = new Map<string, DomainHandler>();
  const handle = vi.fn((channel: string, fn: DomainHandler) => {
    registry.set(channel, fn);
  });
  return {
    handle,
    getHandler: () => {
      const fn = registry.get(IPC_DOMAINS.DATA);
      if (!fn) throw new Error('DATA handler not registered');
      return fn;
    },
  };
}

describe('data.ipc data management access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = null;
    mocks.sessionVerified = false;
    mocks.getDatabase.mockReturnValue(mocks.db);
    mocks.db.getStats.mockReturnValue({
      sessionCount: 12,
      messageCount: 140,
      toolExecutionCount: 31,
      knowledgeCount: 4,
    });
    mocks.db.getSnapshotStats.mockReturnValue({
      snapshotCount: 2,
      sessionCount: 1,
      totalBytes: 64,
    });
    mocks.db.getCompactionStats.mockReturnValue({
      snapshotCount: 3,
      sessionCount: 2,
      totalBytes: 128,
    });
    mocks.db.getPreference.mockReturnValue(7);
    mocks.db.getToolCacheCount.mockReturnValue(5);
    mocks.db.getLocalCacheStats.mockReturnValue({ sessionCount: 12, messageCount: 140 });
    mocks.db.clearToolCache.mockReturnValue(3);
    mocks.db.clearAllMessages.mockReturnValue(140);
    mocks.db.clearAllSessions.mockReturnValue(12);
    mocks.toolCache.getStats.mockReturnValue({ totalEntries: 4 });
  });

  it('rejects non-admin snapshot stats before touching the database', async () => {
    const ipc = makeFakeIpc();
    registerDataHandlers(ipc as never);

    const response = await ipc.getHandler()({}, { action: 'getSnapshotStats' });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it('allows non-admin runtime cache clearing without deleting retained sessions or messages', async () => {
    const ipc = makeFakeIpc();
    registerDataHandlers(ipc as never);

    const response = await ipc.getHandler()({}, { action: 'clearToolCache' });

    expect(response).toMatchObject({ success: true, data: 7 });
    expect(mocks.toolCache.clear).toHaveBeenCalledOnce();
    expect(mocks.sessionManager.clearCache).toHaveBeenCalledOnce();
    expect(mocks.db.clearToolCache).toHaveBeenCalledOnce();
    expect(mocks.db.clearAllMessages).not.toHaveBeenCalled();
    expect(mocks.db.clearAllSessions).not.toHaveBeenCalled();
  });

  it('reports runtime cache count without counting retained sessions and messages', async () => {
    const ipc = makeFakeIpc();
    registerDataHandlers(ipc as never);

    const response = await ipc.getHandler()({}, { action: 'getStats' });

    expect(response).toMatchObject({
      success: true,
      data: {
        cacheEntries: 9,
        sessionCount: 12,
        messageCount: 140,
      },
    });
    expect(mocks.db.getLocalCacheStats).not.toHaveBeenCalled();
  });

  it('allows admins to read snapshot stats', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
    mocks.sessionVerified = true;
    const ipc = makeFakeIpc();
    registerDataHandlers(ipc as never);

    const response = await ipc.getHandler()({}, { action: 'getSnapshotStats' });

    expect(response).toMatchObject({
      success: true,
      data: {
        snapshotCount: 5,
        sessionCount: 2,
        totalBytes: 192,
        retentionDays: 7,
      },
    });
    expect(mocks.getDatabase).toHaveBeenCalledOnce();
  });
});

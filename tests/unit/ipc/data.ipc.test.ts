import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';

const mocks = vi.hoisted(() => ({
  currentUser: null as null | { id: string; email: string; isAdmin?: boolean },
  db: {
    getSnapshotStats: vi.fn(),
    getCompactionStats: vi.fn(),
    getPreference: vi.fn(),
  },
  getDatabase: vi.fn(),
}));

vi.mock('../../../src/main/services/auth', () => ({
  getAuthService: () => ({
    getCurrentUser: () => mocks.currentUser,
  }),
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: mocks.getDatabase,
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

describe('data.ipc admin-only debug snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser = null;
    mocks.getDatabase.mockReturnValue(mocks.db);
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

  it('rejects non-admin full cache clearing before touching the database', async () => {
    const ipc = makeFakeIpc();
    registerDataHandlers(ipc as never);

    const response = await ipc.getHandler()({}, { action: 'clearToolCache' });

    expect(response).toMatchObject({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it('allows admins to read snapshot stats', async () => {
    mocks.currentUser = { id: 'admin-1', email: 'admin@example.com', isAdmin: true };
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

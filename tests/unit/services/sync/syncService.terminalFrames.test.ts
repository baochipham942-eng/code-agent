import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistTerminalFrame,
  readTerminalFrame,
} from '../../../../src/host/services/surfaceExecution/TerminalFrameStore';

const mocks = vi.hoisted(() => {
  const remoteByTable: Record<string, unknown[]> = {
    sessions: [],
    messages: [],
    user_preferences: [],
    devices: [],
  };
  const db = {
    getSession: vi.fn(),
    deleteSession: vi.fn(),
    createSessionWithId: vi.fn(),
    updateSession: vi.fn(),
    getMessages: vi.fn(() => []),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    markMessagesSynced: vi.fn(),
    setPreference: vi.fn(),
    getUnsyncedSessions: vi.fn(() => []),
    getUnsyncedMessages: vi.fn(() => []),
    markSessionsSynced: vi.fn(),
  };

  function query(table: string) {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gt', 'order', 'limit', 'update', 'upsert', 'single']) {
      builder[method] = vi.fn(() => builder);
    }
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({
      data: remoteByTable[table] ?? [],
      error: null,
    }));
    return builder;
  }

  return {
    remoteByTable,
    db,
    supabase: { from: vi.fn((table: string) => query(table)) },
  };
});

vi.mock('../../../../src/host/services/infra', () => ({
  getSupabase: () => mocks.supabase,
  isSupabaseInitialized: () => true,
}));

vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => mocks.db,
  getSecureStorage: () => ({
    getDeviceId: () => 'device-1',
    getDeviceName: () => 'Test device',
  }),
}));

vi.mock('../../../../src/host/services/auth', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: 'user-1' }) }),
}));

vi.mock('../../../../src/host/services/serviceRegistry', () => ({
  Disposable: class {},
  getServiceRegistry: () => ({ register: vi.fn() }),
}));

describe('SyncService terminal frame deletion', () => {
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-terminal-frames-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    mocks.remoteByTable.sessions = [];
    mocks.remoteByTable.messages = [];
    mocks.remoteByTable.user_preferences = [];
    mocks.db.getSession.mockReset();
    mocks.db.deleteSession.mockReset();
    mocks.supabase.from.mockClear();
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('removes the local frame before applying a remote conversation tombstone', async () => {
    const selector = { conversationId: 'remote-delete', surfaceSessionId: 'surface-1' };
    await persistTerminalFrame(selector, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    mocks.db.getSession.mockReturnValue({ id: 'remote-delete', updatedAt: 100 });
    mocks.remoteByTable.sessions = [{
      id: 'remote-delete',
      user_id: 'user-1',
      updated_at: 200,
      is_deleted: true,
    }];
    const { getSyncService } = await import('../../../../src/host/services/sync/syncService');

    const result = await getSyncService().forceFullSync();

    expect(result.success).toBe(true);
    expect(mocks.db.deleteSession).toHaveBeenCalledWith('remote-delete', {
      deletedAt: 200,
      syncOrigin: 'remote',
    });
    await expect(readTerminalFrame(selector)).resolves.toBeNull();
  });

  it('does not tombstone the conversation when its frame directory cannot be removed', async () => {
    const invalidRoot = path.join(dataDir, 'regular-file');
    await fs.writeFile(invalidRoot, 'not a directory');
    process.env.CODE_AGENT_DATA_DIR = invalidRoot;
    mocks.db.getSession.mockReturnValue({ id: 'remote-delete', updatedAt: 100 });
    mocks.remoteByTable.sessions = [{
      id: 'remote-delete',
      user_id: 'user-1',
      updated_at: 200,
      is_deleted: true,
    }];
    const { getSyncService } = await import('../../../../src/host/services/sync/syncService');

    const result = await getSyncService().forceFullSync();

    expect(result.success).toBe(false);
    expect(mocks.db.deleteSession).not.toHaveBeenCalled();
  });
});

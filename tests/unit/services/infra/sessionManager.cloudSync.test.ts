import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

const dbState = {
  sessions: [] as any[],
};

const dbMock = {
  listSessions: vi.fn(() => dbState.sessions),
  getSession: vi.fn((id: string) => dbState.sessions.find((session) => session.id === id) ?? null),
  createSessionWithId: vi.fn(),
  updateSession: vi.fn(),
  getRecentMessages: vi.fn(() => [] as any[]),
};

const supabaseLimitMock = vi.fn();

vi.mock('../../../../src/main/platform', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }],
  },
}));

vi.mock('../../../../src/main/services/core', () => ({
  getDatabase: () => dbMock,
}));

vi.mock('../../../../src/main/services/infra/toolCache', () => ({
  getToolCache: () => ({
    clearSession: vi.fn(),
  }),
}));

vi.mock('../../../../src/main/services/auth/authService', () => ({
  getAuthService: () => ({
    getCurrentUser: () => ({ id: 'user-1' }),
  }),
}));

vi.mock('../../../../src/main/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => true,
  getSupabase: () => ({
    from: () => ({
      select() { return this; },
      eq() { return this; },
      order() { return this; },
      limit: supabaseLimitMock,
    }),
  }),
}));

describe('SessionManager cloud sync notifications', () => {
  beforeEach(() => {
    sendMock.mockReset();
    dbMock.listSessions.mockClear();
    dbMock.getSession.mockClear();
    dbMock.createSessionWithId.mockClear();
    dbMock.updateSession.mockClear();
    supabaseLimitMock.mockReset();
  });

  it('does not broadcast session:list-updated when cloud sync finds no metadata changes', async () => {
    dbState.sessions = [{
      id: 'session-1',
      title: 'Same',
      updatedAt: 100,
      createdAt: 10,
      workingDirectory: '/repo/app',
    }];
    supabaseLimitMock.mockResolvedValue({
      data: [{
        id: 'session-1',
        title: 'Same',
        model_provider: 'openai',
        model_name: 'gpt-5',
        working_directory: '/repo/app',
        created_at: 10,
        updated_at: 100,
        is_deleted: false,
      }],
      error: null,
    });

    const { SessionManager } = await import('../../../../src/main/services/infra/sessionManager');
    const manager = new SessionManager();

    const sessions = await manager.listSessions();
    expect(sessions).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dbMock.createSessionWithId).not.toHaveBeenCalled();
    expect(dbMock.updateSession).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('broadcasts session:list-updated once when cloud sync updates local metadata', async () => {
    dbState.sessions = [{
      id: 'session-1',
      title: 'Old',
      updatedAt: 100,
      createdAt: 10,
      workingDirectory: '/repo/app',
    }];
    supabaseLimitMock.mockResolvedValue({
      data: [{
        id: 'session-1',
        title: 'New',
        model_provider: 'openai',
        model_name: 'gpt-5',
        working_directory: '/repo/app',
        created_at: 10,
        updated_at: 200,
        is_deleted: false,
      }],
      error: null,
    });

    const { SessionManager } = await import('../../../../src/main/services/infra/sessionManager');
    const manager = new SessionManager();

    await manager.listSessions();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dbMock.updateSession).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

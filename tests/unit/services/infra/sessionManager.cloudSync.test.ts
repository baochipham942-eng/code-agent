import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

const dbState = {
  sessions: [] as any[],
};

const dbMock = {
  listSessions: vi.fn((_limit = 50, _offset = 0, _includeArchived = false, userId?: string | null) =>
    dbState.sessions.filter((session) => userId === undefined || (userId === null ? session.userId == null : session.userId === userId))
  ),
  getSession: vi.fn((id: string, options?: { userId?: string | null }) =>
    dbState.sessions.find((session) => {
      if (session.id !== id) return false;
      if (options?.userId === undefined) return true;
      return options.userId === null ? session.userId == null : session.userId === options.userId;
    }) ?? null
  ),
  createSession: vi.fn(),
  createSessionWithId: vi.fn(),
  updateSession: vi.fn(),
  getRecentMessages: vi.fn(() => [] as any[]),
  logAuditEvent: vi.fn(),
};

const supabaseLimitMock = vi.fn();

vi.mock('../../../../src/host/platform', () => ({
  AppWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }],
  },
}));

vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => dbMock,
}));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    clearSession: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({
    getCurrentUser: () => ({ id: 'user-1' }),
  }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
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
    dbState.sessions = [];
    sendMock.mockReset();
    dbMock.listSessions.mockClear();
    dbMock.getSession.mockClear();
    dbMock.createSession.mockClear();
    dbMock.createSessionWithId.mockClear();
    dbMock.updateSession.mockClear();
    dbMock.logAuditEvent.mockClear();
    supabaseLimitMock.mockReset();
  });

  it('broadcasts session:list-updated after creating a local session', async () => {
    const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
    const manager = new SessionManager();

    const session = await manager.createSession({
      title: 'REST-created session',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
    });

    expect(dbMock.createSession).toHaveBeenCalledWith(expect.objectContaining({
      id: session.id,
      title: 'REST-created session',
    }));
    expect(dbMock.logAuditEvent).toHaveBeenCalledWith('session_created', { sessionId: session.id }, session.id);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast session:list-updated when cloud sync finds no metadata changes', async () => {
    dbState.sessions = [{
      id: 'session-1',
      userId: 'user-1',
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

    const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
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
      userId: 'user-1',
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

    const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
    const manager = new SessionManager();

    await manager.listSessions();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dbMock.updateSession).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('lists only sessions for the current auth user', async () => {
    dbState.sessions = [
      {
        id: 'session-user-1',
        userId: 'user-1',
        title: 'Mine',
        updatedAt: 100,
        createdAt: 10,
      },
      {
        id: 'session-user-2',
        userId: 'user-2',
        title: 'Other user',
        updatedAt: 90,
        createdAt: 9,
      },
    ];
    supabaseLimitMock.mockResolvedValue({
      data: [],
      error: null,
    });

    const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
    const manager = new SessionManager();

    const sessions = await manager.listSessions();

    expect(dbMock.listSessions).toHaveBeenCalledWith(50, 0, false, 'user-1');
    expect(sessions.map((session) => session.id)).toEqual(['session-user-1']);
  });
});

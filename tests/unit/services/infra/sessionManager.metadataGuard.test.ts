// Codex audit R2：通用 updateSession 整列 metadata 替换不得抹掉 modelOverride 标记（MED-B）
// + patchSessionMetadata 写审计日志（LOW）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

const dbState = {
  sessions: [] as Array<Record<string, unknown>>,
};

const dbMock = {
  listSessions: vi.fn(() => dbState.sessions),
  getSession: vi.fn((id: string) => dbState.sessions.find((s) => s.id === id) ?? null),
  createSession: vi.fn(),
  createSessionWithId: vi.fn(),
  updateSession: vi.fn(),
  patchSessionMetadata: vi.fn(() => true),
  getRecentMessages: vi.fn(() => []),
  logAuditEvent: vi.fn(),
};

vi.mock('../../../../src/host/platform', () => ({
  AppWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }],
  },
}));

vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => dbMock,
}));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn() }),
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: 'user-1' }) }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => false,
  getSupabase: () => null,
}));

async function makeManager() {
  const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
  return new SessionManager();
}

describe('SessionManager metadata guard (Codex audit R2)', () => {
  beforeEach(() => {
    dbState.sessions = [];
    vi.clearAllMocks();
    dbMock.patchSessionMetadata.mockReturnValue(true);
  });

  it('generic updateSession with metadata preserves an existing modelOverride marker', async () => {
    dbState.sessions = [{
      id: 'session-1',
      userId: 'user-1',
      title: 'S',
      metadata: { modelOverride: { provider: 'zhipu', model: 'glm-5', setAt: 1 }, other: 'x' },
    }];
    const manager = await makeManager();

    await manager.updateSession('session-1', { metadata: { fresh: true } });

    const [, updates] = dbMock.updateSession.mock.calls[0];
    expect(updates.metadata).toEqual({
      fresh: true,
      modelOverride: { provider: 'zhipu', model: 'glm-5', setAt: 1 },
    });
  });

  it('explicit modelOverride key in updates.metadata wins (no double-inject)', async () => {
    dbState.sessions = [{
      id: 'session-1',
      userId: 'user-1',
      title: 'S',
      metadata: { modelOverride: { provider: 'zhipu', model: 'glm-5', setAt: 1 } },
    }];
    const manager = await makeManager();

    await manager.updateSession('session-1', {
      metadata: { modelOverride: { provider: 'deepseek', model: 'deepseek-chat', setAt: 2 } },
    });

    const [, updates] = dbMock.updateSession.mock.calls[0];
    expect(updates.metadata.modelOverride).toMatchObject({ provider: 'deepseek' });
  });

  it('no marker in DB → metadata replace passes through untouched', async () => {
    dbState.sessions = [{ id: 'session-1', userId: 'user-1', title: 'S', metadata: { old: 1 } }];
    const manager = await makeManager();

    await manager.updateSession('session-1', { metadata: { fresh: true } });

    const [, updates] = dbMock.updateSession.mock.calls[0];
    expect(updates.metadata).toEqual({ fresh: true });
  });

  it('patchSessionMetadata writes an audit log entry', async () => {
    dbState.sessions = [{ id: 'session-1', userId: 'user-1', title: 'S' }];
    const manager = await makeManager();

    await manager.patchSessionMetadata('session-1', { modelOverride: null });

    expect(dbMock.logAuditEvent).toHaveBeenCalledWith(
      'session_metadata_patched',
      expect.objectContaining({ sessionId: 'session-1', keys: ['modelOverride'] }),
      'session-1',
    );
  });
});

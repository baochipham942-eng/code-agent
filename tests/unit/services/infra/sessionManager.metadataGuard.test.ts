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
  addMessage: vi.fn(),
  saveTodos: vi.fn(),
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

  it('sanitizes legacy Surface metadata and messages before importing them', async () => {
    const rawSurfaceMetadata = {
      surfaceExecutionSessionV1: {
        version: 1,
        sessionId: 'surface-import',
        runId: 'run-import',
        conversationId: 'conversation-import',
        agentId: 'agent-import',
        surface: 'browser',
        provider: 'relay',
        state: 'completed',
        grantId: 'grant-import-secret',
        activeTarget: { tabRef: 'tab-import-secret' },
        startedAt: 10,
        heartbeatAt: 20,
      },
      surfaceExecutionEventsV1: [{
        version: 1,
        eventId: 'event-import',
        sequence: 1,
        sessionId: 'surface-import',
        runId: 'run-import',
        agentId: 'agent-import',
        surface: 'browser',
        provider: 'relay',
        sessionState: 'completed',
        phase: 'verify',
        status: 'succeeded',
        userSummary: '导入结果已复验',
        target: {
          kind: 'browser',
          browserInstanceId: 'browser-import-secret',
          windowRef: 'window-import-secret',
          tabRef: 'tab-import-secret',
          documentRevision: 'revision-import-secret',
        },
        observation: { verdict: 'pass', findings: ['业务状态正确'] },
        evidenceRefs: [],
        artifactRefs: [],
        availableControls: [],
        startedAt: 10,
        completedAt: 20,
      }],
      grant: { grantId: 'grant-metadata-secret' },
      targetRef: 'target-metadata-secret',
      profilePath: '/Users/private/profile-import-secret',
      cookie: 'cookie-import-secret',
      token: 'token-import-secret',
      reasoningContent: 'raw imported chain of thought',
      ordinaryMetadata: 'preserved',
    };
    const manager = await makeManager();

    await manager.importSession({
      id: 'legacy-session',
      title: 'Legacy import',
      modelConfig: { provider: 'openai', model: 'test' },
      createdAt: 1,
      updatedAt: 2,
      metadata: rawSurfaceMetadata,
      messages: [{
        id: 'legacy-message',
        role: 'assistant',
        content: '旧消息仍可读',
        timestamp: 2,
        reasoning: 'raw message reasoning',
        thinking: 'raw message thinking',
        metadata: rawSurfaceMetadata,
        toolCalls: [{
          id: 'legacy-tool-call',
          name: 'legacy_custom_tool',
          arguments: { legacyFlag: true },
        }],
      }],
      todos: [],
      messageCount: 1,
    } as never);

    const storedSession = dbMock.createSession.mock.calls[0][0] as Record<string, unknown>;
    const storedMessage = dbMock.addMessage.mock.calls[0][1] as Record<string, unknown>;
    expect(storedSession.metadata).toMatchObject({
      ordinaryMetadata: 'preserved',
      surfaceExecutionExportV1: {
        version: 1,
        sessions: [{
          sessionId: 'surface-import',
          events: [{ eventId: 'event-import', status: 'succeeded' }],
        }],
      },
    });
    expect(storedMessage).toMatchObject({
      content: '旧消息仍可读',
      toolCalls: [{
        name: 'legacy_custom_tool',
        arguments: { legacyFlag: true },
      }],
    });
    expect(storedMessage.reasoning).toBeUndefined();
    expect(storedMessage.thinking).toBeUndefined();
    const serialized = JSON.stringify({ storedSession, storedMessage });
    expect(serialized).not.toContain('surfaceExecutionSessionV1');
    expect(serialized).not.toContain('surfaceExecutionEventsV1');
    expect(serialized).not.toContain('grant-import-secret');
    expect(serialized).not.toContain('target-metadata-secret');
    expect(serialized).not.toContain('profile-import-secret');
    expect(serialized).not.toContain('cookie-import-secret');
    expect(serialized).not.toContain('token-import-secret');
    expect(serialized).not.toContain('raw imported chain of thought');
    expect(serialized).not.toContain('raw message reasoning');
  });
});

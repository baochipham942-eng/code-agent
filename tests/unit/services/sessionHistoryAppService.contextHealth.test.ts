import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  messages: new Map<string, any[]>(),
}));

const database = vi.hoisted(() => ({
  getSession: vi.fn(),
  getMessages: vi.fn((sessionId: string) => state.messages.get(sessionId) ?? []),
  createSessionFork: vi.fn(),
  applyPromptRewind: vi.fn(),
  restorePromptRewind: vi.fn(),
}));

const sessionManager = vi.hoisted(() => ({
  invalidateSessionCache: vi.fn(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => database,
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManager,
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => null }),
}));

import { SessionHistoryAppService } from '../../../src/host/app/sessionHistoryAppService';
import { getContextHealthService } from '../../../src/host/context/contextHealthService';
import { resolveContextHealthForSession } from '../../../src/host/ipc/contextHealth.ipc';

const taskManager = {
  getSessionState: vi.fn(() => ({ status: 'idle' })),
  setSessionContext: vi.fn(),
};

function message(id: string, role: 'user' | 'assistant', content: string, timestamp: number) {
  return { id, role, content, timestamp };
}

function seedStaleHealth(sessionId: string, content: string) {
  return getContextHealthService().update(
    sessionId,
    [{ role: 'user', content }],
    '',
    'gpt-5.5',
  );
}

async function queryHealth(sessionId: string) {
  return resolveContextHealthForSession({
    getAppService: () => ({
      getMessages: async (requestedSessionId: string) => state.messages.get(requestedSessionId) ?? [],
      getModelOverride: () => undefined,
    }) as never,
  }, sessionId);
}

describe('SessionHistoryAppService context health invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.messages.clear();
    getContextHealthService().clear();
  });

  it('invalidates an idempotently reused fork child before the next health query', async () => {
    const sourceSession = {
      id: 'source-session',
      title: 'Source',
      modelConfig: { provider: 'openai', model: 'gpt-5.5' },
      engine: { kind: 'native' },
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
    };
    const childSession = { ...sourceSession, id: 'child-session' };
    database.getSession.mockImplementation((sessionId: string) => (
      sessionId === sourceSession.id ? sourceSession : childSession
    ));
    database.createSessionFork.mockReturnValue({
      childSessionId: childSession.id,
      copiedMessageCount: 1,
      sourcePrefixDigest: 'digest',
      messageMappings: [],
      lineage: {
        forkId: 'fork-1',
        rootSessionId: sourceSession.id,
        parentSessionId: sourceSession.id,
        childSessionId: childSession.id,
        sourceAnchorMessageId: 'a1',
        anchorChildMessageId: 'child-a1',
        depth: 1,
        workspaceMode: 'shared_current',
        contextDeliveryMode: 'neo_native_prefix',
        status: 'completed',
        syncState: 'local_only',
        createdAt: 2,
      },
    });
    state.messages.set(childSession.id, [message('child-a1', 'assistant', '短分支内容', 2)]);
    const stale = seedStaleHealth(childSession.id, '旧的超长分支内容'.repeat(500));

    const service = new SessionHistoryAppService(() => taskManager as never);
    await service.forkSession({
      sourceSessionId: sourceSession.id,
      anchorAssistantMessageId: 'a1',
      idempotencyKey: 'fork-request-1',
      workspaceMode: 'shared_current',
    });
    const refreshed = await queryHealth(childSession.id);

    expect(refreshed.currentTokens).toBeLessThan(stale.currentTokens);
    expect(refreshed.breakdown.messages).toBeGreaterThan(0);
  });

  it('invalidates rewind-hidden messages before the next health query', async () => {
    const sessionId = 'rewind-session';
    const activeMessages = [message('u1', 'user', '保留的提示词', 1)];
    database.applyPromptRewind.mockReturnValue({
      rewindId: 'rewind-1',
      anchorMessage: activeMessages[0],
      hiddenMessageIds: ['a1'],
      activeMessages,
      hiddenMessageCount: 1,
    });
    state.messages.set(sessionId, activeMessages);
    const stale = seedStaleHealth(sessionId, '已经被 rewind 隐藏的旧回复'.repeat(500));

    const service = new SessionHistoryAppService(() => taskManager as never);
    await service.rewindConversation({
      sessionId,
      anchorUserMessageId: 'u1',
      idempotencyKey: 'rewind-request-1',
    });
    const refreshed = await queryHealth(sessionId);

    expect(refreshed.currentTokens).toBeLessThan(stale.currentTokens);
    expect(refreshed.breakdown.messages).toBeGreaterThan(0);
  });

  it('invalidates restored rewind messages before the next health query', async () => {
    const sessionId = 'restore-rewind-session';
    const restoredMessages = [
      message('u1', 'user', '原始提示词', 1),
      message('a1', 'assistant', '重新恢复的长回复'.repeat(500), 2),
    ];
    database.restorePromptRewind.mockReturnValue({
      rewindId: 'rewind-1',
      restoredMessageCount: 1,
      activeMessages: restoredMessages,
    });
    state.messages.set(sessionId, restoredMessages);
    const stale = seedStaleHealth(sessionId, '旧的短 health');

    const service = new SessionHistoryAppService(() => taskManager as never);
    await service.restoreConversationRewind({ sessionId, rewindId: 'rewind-1' });
    const refreshed = await queryHealth(sessionId);

    expect(refreshed.currentTokens).toBeGreaterThan(stale.currentTokens);
  });
});

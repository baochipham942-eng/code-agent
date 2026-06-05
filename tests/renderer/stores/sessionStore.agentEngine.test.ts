import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { Session } from '../../../src/shared/contract/session';

const mockDomainInvoke = vi.fn();

function resetSessionStore(): void {
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    messages: [],
    todos: [],
    streamSnapshot: null,
    isLoading: false,
    error: null,
    unreadSessionIds: new Set<string>(),
    runningSessionIds: new Set<string>(),
    sessionRuntimes: new Map(),
    backgroundTasks: [],
    hasOlderMessages: false,
    isLoadingOlder: false,
    sessionDesignBriefs: new Map(),
  });
  useSessionUIStore.setState({
    filter: 'active',
    searchQuery: '',
    sessionStatusFilter: 'all',
  });
}

function makeSession(overrides: Partial<SessionWithMeta> = {}): SessionWithMeta {
  return {
    id: 'session-1',
    title: 'Session',
    modelConfig: {
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
    } as Session['modelConfig'],
    workingDirectory: '/repo/code-agent',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    ...overrides,
  };
}

describe('sessionStore Agent Engine metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: {
        invoke: mockDomainInvoke,
      },
    };
    resetSessionStore();
  });

  it('normalizes old sessions to native when loading the session list', async () => {
    mockDomainInvoke.mockResolvedValueOnce({
      success: true,
      data: [
        {
          id: 'old-session',
          title: 'Old session',
          modelConfig: {
            provider: 'openai',
            model: 'gpt-5',
          },
          createdAt: 1,
          updatedAt: 1,
          messageCount: 0,
          turnCount: 0,
        },
      ],
    });

    await useSessionStore.getState().loadSessions();

    expect(useSessionStore.getState().sessions[0].engine).toEqual({
      kind: 'native',
      permissionProfile: 'default',
      origin: 'manual',
    });
  });

  it('does not append meta messages from hidden background runs', () => {
    useSessionStore.setState({
      sessions: [makeSession({ id: 'session-1' })],
      currentSessionId: 'session-1',
      messages: [],
      streamSnapshot: {
        sessionId: 'session-1',
        turnId: 'meta-1',
        content: 'hidden',
        reasoning: '',
        toolCalls: [],
        estimatedTokens: 1,
        timestamp: 1,
        isFinal: false,
        streamStatus: 'incomplete',
      },
    });

    useSessionStore.getState().addMessage({
      id: 'meta-1',
      role: 'assistant',
      content: 'hidden loop output',
      timestamp: 1,
      isMeta: true,
    });

    expect(useSessionStore.getState().messages).toEqual([]);
    expect(useSessionStore.getState().streamSnapshot).toBeNull();
    expect(useSessionStore.getState().sessions[0].messageCount).toBe(0);
  });

  it('updates session engine metadata without switching the model provider', async () => {
    const existing = makeSession({
      id: 'session-1',
      engine: {
        kind: 'native',
        permissionProfile: 'default',
        origin: 'manual',
      },
    });
    useSessionStore.setState({
      sessions: [existing],
      currentSessionId: 'session-1',
    });
    mockDomainInvoke.mockResolvedValueOnce({
      success: true,
      data: {
        kind: 'codex_cli',
        model: 'gpt-5',
        cwd: '/repo/code-agent',
        permissionProfile: 'read_only',
        origin: 'manual',
        updatedAt: 123,
      },
    });

    await useSessionStore.getState().updateSessionEngine('session-1', {
      kind: 'codex_cli',
      model: 'gpt-5',
      permissionProfile: 'read_only',
      origin: 'manual',
    });

    expect(mockDomainInvoke).toHaveBeenCalledWith(IPC_DOMAINS.AGENT_ENGINE, 'select', {
      sessionId: 'session-1',
      kind: 'codex_cli',
      model: 'gpt-5',
      permissionProfile: 'read_only',
    });
    expect(mockDomainInvoke).not.toHaveBeenCalledWith(
      IPC_DOMAINS.SESSION,
      'switchModel',
      expect.anything(),
    );
    const updated = useSessionStore.getState().sessions[0];
    expect(updated.engine).toEqual({
      kind: 'codex_cli',
      model: 'gpt-5',
      cwd: '/repo/code-agent',
      permissionProfile: 'read_only',
      origin: 'manual',
      updatedAt: 123,
    });
    expect(updated.modelConfig).toEqual(existing.modelConfig);
  });
});

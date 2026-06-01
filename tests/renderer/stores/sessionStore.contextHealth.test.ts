import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';
import type { ContextHealthState } from '../../../src/shared/contract/contextHealth';
import type { Message, Session, SessionTask, TodoItem } from '../../../src/shared/contract';

const mockDomainInvoke = vi.fn();
const mockInvoke = vi.fn();

function makeHealth(currentTokens: number): ContextHealthState {
  return {
    currentTokens,
    maxTokens: 128000,
    usagePercent: Math.round((currentTokens / 128000) * 1000) / 10,
    breakdown: {
      systemPrompt: 0,
      messages: currentTokens,
      toolResults: 0,
    },
    warningLevel: 'normal',
    estimatedTurnsRemaining: 120,
    lastUpdated: 123,
    compression: {
      status: 'none',
      compressionCount: 0,
      totalSavedTokens: 0,
    },
  };
}

describe('sessionStore context health refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: {
        invoke: mockDomainInvoke,
      },
      electronAPI: {
        invoke: mockInvoke,
        on: vi.fn(() => () => {}),
        off: vi.fn(),
      },
    };

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
    useAppStore.setState({ contextHealth: makeHealth(9999) });
  });

  it('refreshes context health after switching to a persisted session', async () => {
    const session: Session & { messages: Message[]; todos: TodoItem[] } = {
      id: 'session-1',
      title: '历史会话',
      modelConfig: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: '',
        maxTokens: 16384,
      },
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: 'm1', role: 'user', content: '已有消息', timestamp: 1 },
      ],
      todos: [],
      status: 'completed',
    };
    const health = makeHealth(2345);
    const sessionTasks: SessionTask[] = [{
      id: 'task-1',
      subject: 'Inspect task panel',
      description: 'Load SessionTask records for the right rail',
      activeForm: 'Inspecting task panel',
      status: 'pending',
      priority: 'normal',
      blocks: [],
      blockedBy: [],
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }];

    mockDomainInvoke.mockImplementation(async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'load') {
        return { success: true, data: session };
      }
      if (domain === IPC_DOMAINS.SESSION && action === 'getSessionTasks') {
        return { success: true, data: sessionTasks };
      }
      return { success: false, error: { message: 'unexpected domain call' } };
    });
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.CONTEXT_HEALTH_GET) {
        return health;
      }
      return null;
    });

    await useSessionStore.getState().switchSession('session-1');

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.CONTEXT_HEALTH_GET, 'session-1');
    expect(useAppStore.getState().contextHealth).toEqual(health);
    expect(useSessionStore.getState().sessionTasks).toEqual(sessionTasks);
  });

  it('refreshes context health for the current session after a completed turn', async () => {
    const health = makeHealth(7186);
    useSessionStore.setState({
      currentSessionId: 'session-1',
      sessionRuntimes: new Map(),
    });
    useAppStore.setState({ contextHealth: null });
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.CONTEXT_HEALTH_GET) {
        return health;
      }
      return null;
    });

    const result = await useSessionStore.getState().refreshContextHealth('session-1');

    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.CONTEXT_HEALTH_GET, 'session-1');
    expect(result).toEqual(health);
    expect(useAppStore.getState().contextHealth).toEqual(health);
  });

  it('does not replace measured context health with an empty runtime event', () => {
    const measuredHealth = makeHealth(2345);
    const emptyHealth = makeHealth(0);

    useSessionStore.setState({
      currentSessionId: 'session-1',
      sessionRuntimes: new Map([
        ['session-1', {
          sessionId: 'session-1',
          status: 'running',
          activeAgentCount: 1,
          contextHealth: measuredHealth,
          lastActivityAt: 123,
        }],
      ]),
    });
    useAppStore.setState({ contextHealth: measuredHealth });

    useSessionStore.getState().updateSessionRuntime({
      sessionId: 'session-1',
      status: 'idle',
      activeAgentCount: 0,
      contextHealth: emptyHealth,
    });

    expect(useAppStore.getState().contextHealth).toEqual(measuredHealth);
    expect(useSessionStore.getState().sessionRuntimes.get('session-1')?.contextHealth).toEqual(measuredHealth);
  });

  it('keeps a newly created session when an older switch response returns later', async () => {
    let resolveOldLoad: ((value: { success: true; data: Session & { messages: Message[]; todos: TodoItem[] } }) => void) | null = null;
    const oldSession: Session & { messages: Message[]; todos: TodoItem[] } = {
      id: 'old-session',
      title: '旧会话',
      modelConfig: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: '',
        maxTokens: 16384,
      },
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: 'old-message', role: 'user', content: '旧消息', timestamp: 1 },
      ],
      todos: [],
      status: 'completed',
    };
    const newSession: Session = {
      id: 'new-session',
      title: '新建会话',
      modelConfig: {
        provider: 'xiaomi',
        model: 'mimo-v2.5-pro',
        apiKey: '',
        maxTokens: 16384,
      },
      createdAt: 3,
      updatedAt: 3,
      status: 'active',
    };

    useSessionStore.setState({
      sessions: [{
        ...oldSession,
        messageCount: 1,
        turnCount: 1,
      }],
    });

    mockDomainInvoke.mockImplementation(async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'load') {
        return new Promise((resolve) => {
          resolveOldLoad = resolve as typeof resolveOldLoad;
        });
      }
      if (domain === IPC_DOMAINS.SESSION && action === 'getSessionTasks') {
        return { success: true, data: [] };
      }
      if (domain === IPC_DOMAINS.SESSION && action === 'create') {
        return { success: true, data: newSession };
      }
      return { success: false, error: { message: 'unexpected domain call' } };
    });

    const switchPromise = useSessionStore.getState().switchSession('old-session');
    expect(useSessionStore.getState().currentSessionId).toBe('old-session');

    await useSessionStore.getState().createSession('新建会话', { workingDirectory: null });
    expect(useSessionStore.getState().currentSessionId).toBe('new-session');

    resolveOldLoad?.({ success: true, data: oldSession });
    await switchPromise;

    expect(useSessionStore.getState().currentSessionId).toBe('new-session');
    expect(useSessionStore.getState().messages).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC_CHANNELS.CONTEXT_HEALTH_GET, 'old-session');
  });
});

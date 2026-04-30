import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';
import type { ContextHealthState } from '../../../src/shared/contract/contextHealth';
import type { Message, Session, TodoItem } from '../../../src/shared/contract';

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

    mockDomainInvoke.mockImplementation(async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'load') {
        return { success: true, data: session };
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
});

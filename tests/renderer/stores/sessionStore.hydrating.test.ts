// ============================================================================
// isHydratingSession（工单 2026-08-01）：会话切换的消息投影 hydration 窗口标记。
// 骨架屏只认这个信号——切换开始置 true，成功/空会话/异常三条路径都必须落回
// false，否则骨架屏会常驻或加载中被误渲染成空态。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useTaskStore } from '../../../src/renderer/stores/taskStore';
import { applyConversationStreamEvent } from '../../../src/renderer/hooks/agent/effects/useConversationStreamEffects';

const mockDomainInvoke = vi.fn();

function makeSession(id: string): SessionWithMeta {
  return { id, title: id, createdAt: 0, updatedAt: 0, messageCount: 0, turnCount: 0 } as unknown as SessionWithMeta;
}

function loadedSession(id: string, messages: unknown[]) {
  return {
    success: true,
    data: {
      id,
      title: id,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      createdAt: 1,
      updatedAt: 1,
      messages,
      todos: [],
    },
  };
}

describe('switchSession 的 isHydratingSession 窗口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() },
    };
    useSessionStore.setState({
      sessions: [makeSession('s1')],
      currentSessionId: null,
      messages: [],
      isHydratingSession: false,
    });
    useAppStore.setState({ isProcessing: false, processingSessionIds: new Set<string>() });
    useTaskStore.setState({ sessionStates: {} });
  });

  it('切换进行中为 true，hydration 完成（有内容）后落回 false 且消息上屏', async () => {
    let resolveLoad: (value: unknown) => void = () => {};
    mockDomainInvoke.mockImplementation((_domain: string, action: string) => {
      if (action === 'load') {
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    const switching = useSessionStore.getState().switchSession('s1');
    // IPC 未回：hydration 窗口内
    expect(useSessionStore.getState().isHydratingSession).toBe(true);
    expect(useSessionStore.getState().messages).toEqual([]);

    resolveLoad(loadedSession('s1', [
      { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
      { id: 'm2', role: 'assistant', content: 'hello', timestamp: 2 },
    ]));
    await switching;

    expect(useSessionStore.getState().isHydratingSession).toBe(false);
    expect(useSessionStore.getState().messages).toHaveLength(2);
  });

  it('后端返回 null（真空会话）：同样落回 false，交给空态渲染', async () => {
    mockDomainInvoke.mockImplementation((_domain: string, action: string) => {
      if (action === 'load') return Promise.resolve({ success: true, data: null });
      return Promise.resolve({ success: true, data: [] });
    });

    await useSessionStore.getState().switchSession('s1');

    expect(useSessionStore.getState().isHydratingSession).toBe(false);
    expect(useSessionStore.getState().messages).toEqual([]);
  });

  it('加载异常：落回 false，骨架屏不常驻', async () => {
    mockDomainInvoke.mockImplementation((_domain: string, action: string) => {
      if (action === 'load') return Promise.reject(new Error('boom'));
      return Promise.resolve({ success: true, data: [] });
    });

    await useSessionStore.getState().switchSession('s1');

    expect(useSessionStore.getState().isHydratingSession).toBe(false);
    expect(useSessionStore.getState().error).toBe('boom');
  });

  it('epoch 强制 snapshot 期间合并实时尾部，不被较旧 snapshot 覆盖', async () => {
    useSessionStore.setState({
      currentSessionId: 's1',
      messages: [{ id: 'm1', role: 'assistant', content: 'old', timestamp: 1 }],
    });
    let resolveLoad: (value: unknown) => void = () => {};
    mockDomainInvoke.mockImplementation((_domain: string, action: string) => {
      if (action === 'load') {
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    const refreshing = useSessionStore.getState().switchSession('s1', { force: true });
    useSessionStore.getState().updateMessage('m1', { content: 'old + live tail' });
    resolveLoad(loadedSession('s1', [
      { id: 'm1', role: 'assistant', content: 'old + snapshot', timestamp: 1 },
    ]));
    await refreshing;

    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({ id: 'm1', content: 'old + live tail' }),
    ]);
  });

  it('已应用 turn_start/stream_chunk 后 force hydration，迟到的空闲空快照不回退运行态', async () => {
    let resolveLoad: (value: unknown) => void = () => {};
    mockDomainInvoke.mockImplementation((_domain: string, action: string) => {
      if (action === 'load') {
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      }
      return Promise.resolve({ success: true, data: [] });
    });

    useSessionStore.setState({ currentSessionId: 's1' });
    const streamState = {
      currentTurnMessageId: null as string | null,
      committedAssistantMessageIds: new Set<string>(),
    lastDeltaSeqByTurn: new Map<string, number>(),
    };
    const streamActions = {
      addMessage: useSessionStore.getState().addMessage,
      updateMessage: useSessionStore.getState().updateMessage,
      appendStreamingMessageDelta: (messageId: string, delta: { content?: string; reasoning?: string }) => {
        const message = useSessionStore.getState().messages.find((item) => item.id === messageId);
        useSessionStore.getState().updateMessage(messageId, {
          content: `${message?.content ?? ''}${delta.content ?? ''}`,
          reasoning: `${message?.reasoning ?? ''}${delta.reasoning ?? ''}` || undefined,
        });
      },
      setMessages: useSessionStore.getState().setMessages,
      getMessages: () => useSessionStore.getState().messages,
      queueUpdate: () => {},
      now: () => 2,
    };

    useAppStore.getState().setSessionProcessing('s1', true);
    useTaskStore.getState().updateSessionState('s1', { status: 'running' });
    applyConversationStreamEvent(
      { type: 'turn_start', sessionId: 's1', data: { turnId: 'live-turn' } },
      streamState,
      streamActions,
    );
    applyConversationStreamEvent(
      { type: 'stream_chunk', sessionId: 's1', data: { turnId: 'live-turn', content: 'live partial' } },
      streamState,
      streamActions,
    );

    const switching = useSessionStore.getState().switchSession('s1', { force: true });

    resolveLoad({
      success: true,
      data: {
        ...loadedSession('s1', []).data,
        status: 'idle',
        activeRun: false,
      },
    });
    await switching;

    expect(useSessionStore.getState().messages).toEqual([
      expect.objectContaining({ id: 'live-turn', content: 'live partial' }),
    ]);
    expect(useAppStore.getState().processingSessionIds.has('s1')).toBe(true);
    expect(useTaskStore.getState().sessionStates.s1?.status).toBe('running');
  });
});

// @vitest-environment jsdom
// ============================================================================
// sessionStore ↔ appStore activeAgentId per-session 同步（三层一致性批③ S3）
// ----------------------------------------------------------------------------
// 会话切换/创建/删除必须同步 per-session agent 选择，消灭 localStorage 全局
// 单值时代的跨会话残留路由（会话 A 选 Explorer，会话 B 静默继续用 Explorer）。
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { Message, Session, TodoItem } from '../../../src/shared/contract';

const mockDomainInvoke = vi.fn();
const mockInvoke = vi.fn();

const SESSION_MAP_KEY = 'app:activeAgentIdBySession';

function makeSession(id: string): Session & { messages: Message[]; todos: TodoItem[] } {
  return {
    id,
    title: `会话 ${id}`,
    modelConfig: { provider: 'zhipu', model: 'glm-5' },
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    todos: [],
  } as unknown as Session & { messages: Message[]; todos: TodoItem[] };
}

describe('sessionStore activeAgentId per-session sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
      electronAPI: { invoke: mockInvoke, on: vi.fn(() => () => {}), off: vi.fn() },
    };

    useSessionStore.setState({
      sessions: [
        { ...makeSession('session-a'), messageCount: 0, turnCount: 0 },
        { ...makeSession('session-b'), messageCount: 0, turnCount: 0 },
      ] as unknown as ReturnType<typeof useSessionStore.getState>['sessions'],
      currentSessionId: null,
      messages: [],
      todos: [],
      sessionTasks: [],
      streamSnapshot: null,
      isLoading: false,
      error: null,
      unreadSessionIds: new Set<string>(),
      runningSessionIds: new Set<string>(),
      sessionRuntimes: new Map(),
      backgroundSessions: [],
      hasOlderMessages: false,
      isLoadingOlder: false,
      sessionDesignBriefs: new Map(),
    });
    useAppStore.setState({ activeAgentId: null, activeAgentSessionKey: null });

    mockDomainInvoke.mockImplementation(async (_domain: string, op: string, params?: { sessionId?: string }) => {
      if (op === 'load') return makeSession(params?.sessionId || 'session-a');
      if (op === 'getSessionTasks') return [];
      if (op === 'delete') return { success: true };
      return null;
    });
  });

  it('switchSession 同步 per-session 选择：A 有选择、B 无选择', async () => {
    localStorage.setItem(SESSION_MAP_KEY, JSON.stringify({ 'session-a': 'explore' }));

    await useSessionStore.getState().switchSession('session-a');
    expect(useAppStore.getState().activeAgentId).toBe('explore');

    await useSessionStore.getState().switchSession('session-b');
    expect(useAppStore.getState().activeAgentId).toBeNull();
  });

  it('deleteSession 清理该会话的持久化选择', async () => {
    localStorage.setItem(SESSION_MAP_KEY, JSON.stringify({ 'session-b': 'coder' }));
    await useSessionStore.getState().switchSession('session-a');

    await useSessionStore.getState().deleteSession('session-b');

    const stored = JSON.parse(localStorage.getItem(SESSION_MAP_KEY) || '{}') as Record<string, string>;
    expect(stored['session-b']).toBeUndefined();
  });

  it('删除最后一个会话（currentSessionId 归 null）→ 选择归零', async () => {
    useSessionStore.setState({
      sessions: [
        { ...makeSession('session-only'), messageCount: 0, turnCount: 0 },
      ] as unknown as ReturnType<typeof useSessionStore.getState>['sessions'],
    });
    localStorage.setItem(SESSION_MAP_KEY, JSON.stringify({ 'session-only': 'coder' }));
    await useSessionStore.getState().switchSession('session-only');
    expect(useAppStore.getState().activeAgentId).toBe('coder');

    await useSessionStore.getState().deleteSession('session-only');

    expect(useSessionStore.getState().currentSessionId).toBeNull();
    expect(useAppStore.getState().activeAgentId).toBeNull();
  });
});

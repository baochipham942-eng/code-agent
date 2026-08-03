// ============================================================================
// isHydratingSession（工单 2026-08-01）：会话切换的消息投影 hydration 窗口标记。
// 骨架屏只认这个信号——切换开始置 true，成功/空会话/异常三条路径都必须落回
// false，否则骨架屏会常驻或加载中被误渲染成空态。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

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
});

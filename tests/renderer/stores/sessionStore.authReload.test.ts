import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSessionsForAuthChange, useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { Message } from '../../../src/shared/contract';

const mockDomainInvoke = vi.fn();

function makeRawSession(id: string) {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    turnCount: 1,
  };
}

function makeMessage(id: string): Message {
  return { id, role: 'user', content: 'hello', timestamp: 1 } as Message;
}

function seedRenderedState(): void {
  useSessionStore.setState({
    sessions: [makeRawSession('s1') as SessionWithMeta, makeRawSession('s2') as SessionWithMeta],
    currentSessionId: 's1',
    messages: [makeMessage('m1')],
    todos: [],
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
  useAppStore.getState().setWorkingDirectory('/repo/x');
}

/**
 * 启动闪烁根因回归：auth 从缓存态升级为验证态时 host 会重复推送 signed_in（同一用户），
 * 若按"身份切换"处理会清空已渲染的会话态 → 窗口可见后内容闪空重建（闪 1-2 下）。
 * 同主体（principalChanged=false）必须走静默刷新，不许清 messages/currentSessionId/workingDirectory。
 */
describe('reloadSessionsForAuthChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
    };
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'list') {
        return { success: true, data: [makeRawSession('s1'), makeRawSession('s2')] };
      }
      if (action === 'load') {
        return { success: true, data: { ...makeRawSession('s1'), messages: [], todos: [] } };
      }
      if (action === 'getSessionTasks') {
        return { success: true, data: [] };
      }
      return { success: true, data: null };
    });
  });

  it('同主体（principalChanged=false）静默刷新，不清空已渲染的会话态', async () => {
    seedRenderedState();

    await reloadSessionsForAuthChange({ principalChanged: false });

    const state = useSessionStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].id).toBe('m1');
    expect(state.currentSessionId).toBe('s1');
    expect(useAppStore.getState().workingDirectory).toBe('/repo/x');
    // 不触发 switchSession（不 invoke 'load'）
    const loadCalls = mockDomainInvoke.mock.calls.filter((call) => call[1] === 'load');
    expect(loadCalls).toHaveLength(0);
  });

  it('主体变化（principalChanged=true / 默认）保留破坏性清空语义', async () => {
    seedRenderedState();

    await reloadSessionsForAuthChange({ principalChanged: true });

    // 身份真的切换时必须清空，避免把上一个用户的会话渲染给新用户
    expect(useSessionStore.getState().messages).toHaveLength(0);
    expect(useAppStore.getState().workingDirectory).toBeNull();
  });

  it('keeps durableWaitingInput from the session list payload and clears it when the payload drops the field', async () => {
    mockDomainInvoke.mockImplementationOnce(async (_domain: string, action: string) => {
      if (action === 'list') {
        return {
          success: true,
          data: [
            { ...makeRawSession('s1'), status: 'running', durableWaitingInput: true },
          ],
        };
      }
      return { success: true, data: null };
    });

    await useSessionStore.getState().loadSessions();
    expect(useSessionStore.getState().sessions[0]).toEqual(expect.objectContaining({
      id: 's1',
      status: 'running',
      durableWaitingInput: true,
    }));

    mockDomainInvoke.mockImplementationOnce(async (_domain: string, action: string) => {
      if (action === 'list') {
        return {
          success: true,
          data: [
            { ...makeRawSession('s1'), status: 'running' },
          ],
        };
      }
      return { success: true, data: null };
    });

    await useSessionStore.getState().loadSessions();
    expect(useSessionStore.getState().sessions[0]).not.toHaveProperty('durableWaitingInput');
  });
});

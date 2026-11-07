import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore, type SessionWithMeta } from '../../../src/renderer/stores/sessionStore';
import { toast } from '../../../src/renderer/hooks/useToast';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const mockDomainInvoke = vi.fn();

function blank(id: string): SessionWithMeta {
  return {
    id,
    title: '新对话',
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
  } as SessionWithMeta;
}

const OLD = 'old-session';
const NEW = 'new-session';
const optimisticFirst = {
  id: 'm1', role: 'user' as const, content: '第一个问题', timestamp: 2,
};

function createCalls() {
  return mockDomainInvoke.mock.calls.filter(([, action]) => action === 'create').length;
}

/** 与侧栏「新任务」一致：createSession(title, { workingDirectory }) */
async function clickNewTask() {
  return useSessionStore.getState().createSession('新对话', { workingDirectory: null });
}

describe('新任务：旧会话忙碌时绝不被当作可复用草稿', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
    };
    mockDomainInvoke.mockImplementation(async (_d: string, action: string) => {
      if (action === 'create') return { success: true, data: blank(NEW) };
      return { success: true, data: null };
    });
    useAppStore.setState({
      processingSessionIds: new Set<string>(),
      pendingPermissionRequest: null,
      pendingPermissionSessionId: null,
      queuedPermissionRequests: {},
      workingDirectory: null,
    } as never);
    useSessionStore.setState({
      sessions: [blank(OLD)],
      currentSessionId: OLD,
      messages: [optimisticFirst as never],
      todos: [],
      runningSessionIds: new Set<string>(),
      sessionRuntimes: new Map(),
    } as never);
  });

  async function expectFreshSession() {
    const session = await clickNewTask();
    expect(session?.id).toBe(NEW);
    expect(createCalls()).toBe(1);
    const state = useSessionStore.getState();
    expect(state.currentSessionId).toBe(NEW);
    expect(state.messages).toEqual([]);
    // 旧会话原样保留在列表里，元数据未被改动
    expect(state.sessions.find((s) => s.id === OLD)).toMatchObject({ title: '新对话', messageCount: 0 });
    return state;
  }

  it('(a) 当前会话在跑、首条乐观消息待落库 → 新建而非复用', async () => {
    useSessionStore.setState({ runningSessionIds: new Set([OLD]) } as never);
    useAppStore.setState({ processingSessionIds: new Set([OLD]) } as never);
    await expectFreshSession();
  });

  it('(a2) 仅有首条乐观用户消息、尚无 running 信号 → 新建', async () => {
    await expectFreshSession();
  });

  it('(b) 用户已切走、旧会话仍在跑 → 新建而非切回旧会话', async () => {
    useSessionStore.setState({
      sessions: [blank(OLD)],
      currentSessionId: 'other',
      messages: [],
      runningSessionIds: new Set([OLD]),
    } as never);
    await expectFreshSession();
  });

  it('(c1) 旧会话有待审批卡片 → 新建', async () => {
    useAppStore.setState({
      pendingPermissionRequest: { id: 'p1' } as never,
      pendingPermissionSessionId: OLD,
    } as never);
    useSessionStore.setState({ messages: [] } as never);
    await expectFreshSession();
  });

  it('(c2) 旧会话有后台 agent 在跑 → 新建', async () => {
    useSessionStore.setState({
      messages: [],
      sessionRuntimes: new Map([[OLD, {
        sessionId: OLD, status: 'idle', activeAgentCount: 1, contextHealth: null, lastActivityAt: 1,
      }]]),
    } as never);
    await expectFreshSession();
  });

  it('对照：已使用(messageCount>0)且在跑的旧会话 → 新建', async () => {
    useSessionStore.setState({
      sessions: [{ ...blank(OLD), title: '聊过的', messageCount: 2, turnCount: 1 }],
      runningSessionIds: new Set([OLD]),
    } as never);
    const session = await clickNewTask();
    expect(session?.id).toBe(NEW);
    expect(createCalls()).toBe(1);
  });

  it('对照：空闲空白草稿仍被复用，不发 create', async () => {
    useSessionStore.setState({ messages: [] } as never);
    const session = await clickNewTask();
    expect(session?.id).toBe(OLD);
    expect(createCalls()).toBe(0);
  });

  it('首条消息只进新会话：旧会话的消息列表与元数据不变', async () => {
    useSessionStore.setState({ runningSessionIds: new Set([OLD]) } as never);
    await clickNewTask();
    const state = useSessionStore.getState();
    expect(state.currentSessionId).toBe(NEW);
    expect(state.messages.some((m) => m.id === 'm1')).toBe(false);
    const old = state.sessions.find((s) => s.id === OLD);
    expect(old).toMatchObject({ messageCount: 0, turnCount: 0, updatedAt: 1 });
    expect(mockDomainInvoke.mock.calls.some(([, a]) => a === 'update')).toBe(false);
  });

  it('create IPC 失败时弹出可见 toast 说明原因，而不是静默无反应', async () => {
    const spy = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
    mockDomainInvoke.mockImplementation(async () => { throw new Error('ipc down'); });
    useSessionStore.setState({ runningSessionIds: new Set([OLD]) } as never);
    const session = await clickNewTask();
    expect(session).toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('ipc down'));
    expect(useSessionStore.getState().currentSessionId).toBe(OLD);
    spy.mockRestore();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCreateSession, type SessionCreateDeps } from '../../../src/renderer/stores/sessionCreate';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const mockDomainInvoke = vi.fn();

function makeDraft(id: string): SessionWithMeta {
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

type HarnessState = ReturnType<SessionCreateDeps['get']> & { sessionTasks: never[] };

/**
 * 「新建会话」落在一个已经打开的空白草稿上时，既不切换也不新建——屏幕上零变化，
 * 用户看到的就是「点了没反应」。唯一的回执是把光标交还输入框（composerFocusNonce）。
 */
describe('executeCreateSession — 复用的草稿就是当前会话时给出回执', () => {
  let state: HarnessState;
  let deps: SessionCreateDeps;
  let reusable: SessionWithMeta | null;

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
    };
    mockDomainInvoke.mockResolvedValue({ success: true, data: null });
    useAppStore.setState({ composerFocusNonce: 0 });
    reusable = makeDraft('draft-1');
    state = {
      sessions: [makeDraft('draft-1')],
      currentSessionId: 'draft-1',
      messages: [],
      todos: [],
      sessionTasks: [],
      switchSession: vi.fn(async (_sessionId: string) => {}),
      updateSessionEngine: vi.fn(async () => {}),
    };
    deps = {
      get: () => state,
      set: (partial) => {
        const patch = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...patch };
      },
      invalidatePendingSessionSwitches: () => {},
      findReusableNewSessionDraft: () => reusable,
    };
  });

  it('已经身在那个空白草稿里时，请求聚焦输入框而不是静默什么都不做', async () => {
    await executeCreateSession(deps, '新对话');

    expect(useAppStore.getState().composerFocusNonce).toBe(1);
    expect(state.switchSession).not.toHaveBeenCalled();
    // 没有新建会话：create 从未发出。
    expect(mockDomainInvoke.mock.calls.some(([, action]) => action === 'create')).toBe(false);
  });

  it('草稿是别的会话时走切换，不发聚焦请求', async () => {
    reusable = makeDraft('draft-2');
    state.sessions = [makeDraft('draft-1'), makeDraft('draft-2')];

    await executeCreateSession(deps, '新对话');

    expect(state.switchSession).toHaveBeenCalledWith('draft-2');
    expect(useAppStore.getState().composerFocusNonce).toBe(0);
  });
});

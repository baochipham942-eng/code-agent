import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCreateSession, type SessionCreateDeps } from '../../../src/renderer/stores/sessionCreate';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

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

interface HarnessState {
  sessions: SessionWithMeta[];
  currentSessionId: string | null;
  messages: never[];
  todos: never[];
  switchSession: ReturnType<typeof vi.fn>;
  updateSessionEngine: ReturnType<typeof vi.fn>;
}

/**
 * 侧栏同 id 会话渲染两行（2026-07-30 批 X5-④）的竞态回归：
 * host 在 create 返回前就广播 SESSION_LIST_UPDATED，静默 loadSessions 先把同 id 会话
 * 放进列表；executeCreateSession 的乐观前插若不去重，同 id 就出现两次（同分组相邻两行、
 * 同时高亮）。前插必须按 session id 去重。
 */
describe('executeCreateSession 乐观前插去重', () => {
  let state: HarnessState;
  let deps: SessionCreateDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
    };
    state = {
      sessions: [makeRawSession('existing-1') as SessionWithMeta],
      currentSessionId: 'existing-1',
      messages: [],
      todos: [],
      switchSession: vi.fn(),
      updateSessionEngine: vi.fn(),
    };
    deps = {
      get: () => state,
      set: (partial) => {
        const patch = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...patch } as HarnessState;
      },
      invalidatePendingSessionSwitches: () => {},
      findReusableNewSessionDraft: () => null,
    };
  });

  it('静默 loadSessions 已落地同 id 会话时，前插后该 id 仍只有一条', async () => {
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'create') {
        // 竞态现场：create 尚未返回，SESSION_LIST_UPDATED 触发的静默 loadSessions
        // 已把同 id 会话写进列表。
        state = {
          ...state,
          sessions: [makeRawSession('new-1') as SessionWithMeta, ...state.sessions],
        };
        return { success: true, data: makeRawSession('new-1') };
      }
      return { success: true, data: null };
    });

    const created = await executeCreateSession(deps, '帮我看看当前这个项目。');

    expect(created?.id).toBe('new-1');
    const occurrences = state.sessions.filter((s) => s.id === 'new-1');
    expect(occurrences).toHaveLength(1);
    expect(state.sessions[0].id).toBe('new-1');
    expect(state.currentSessionId).toBe('new-1');
  });

  it('无竞态时正常前插一次', async () => {
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'create') {
        return { success: true, data: makeRawSession('new-2') };
      }
      return { success: true, data: null };
    });

    await executeCreateSession(deps, '普通新会话');

    expect(state.sessions.map((s) => s.id)).toEqual(['new-2', 'existing-1']);
  });
});

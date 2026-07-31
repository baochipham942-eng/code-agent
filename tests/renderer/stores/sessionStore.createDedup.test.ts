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

type HarnessState = ReturnType<SessionCreateDeps['get']> & { sessionTasks: never[] };

describe('executeCreateSession optimistic insert deduplication', () => {
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
      findReusableNewSessionDraft: () => null,
    };
  });

  it('keeps one row when a session-list broadcast wins the create race', async () => {
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'create') {
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
    expect(state.sessions.filter((item) => item.id === 'new-1')).toHaveLength(1);
    expect(state.sessions[0].id).toBe('new-1');
    expect(state.currentSessionId).toBe('new-1');
  });

  it('inserts a new session once when no broadcast races create', async () => {
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'create') {
        return { success: true, data: makeRawSession('new-2') };
      }
      return { success: true, data: null };
    });

    await executeCreateSession(deps, '普通新会话');

    expect(state.sessions.map((item) => item.id)).toEqual(['new-2', 'existing-1']);
  });
});

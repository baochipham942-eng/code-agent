// N-TASK-MEMORY-OFF：新任务级「不用记忆」开关的建会话载荷接线。
// 真实 composerStore（draft 槽标记）+ executeCreateSession，断言：
//   1) 草稿槽开着 → create 载荷带 memoryMode:'off'（首句话即落档，无竞态）；
//   2) 没开 → 载荷不带 memoryMode（不误伤普通会话）；
//   3) 复用空白草稿绕过 create → 补一次 update 把档位落上，本地列表同步。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCreateSession, type SessionCreateDeps } from '../../../src/renderer/stores/sessionCreate';
import { useComposerStore } from '../../../src/renderer/stores/composerStore';
import { DRAFT_SCOPE_KEY } from '../../../src/renderer/stores/composerScopeModel';
import type { SessionWithMeta } from '../../../src/renderer/stores/sessionStore';

const mockDomainInvoke = vi.fn();

function makeRawSession(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    turnCount: 0,
    ...overrides,
  };
}

type HarnessState = ReturnType<SessionCreateDeps['get']> & { sessionTasks: never[] };

function buildHarness(reusable: SessionWithMeta | null): { getState: () => HarnessState; deps: SessionCreateDeps } {
  const holder: { state: HarnessState } = {
    state: {
      sessions: [reusable, makeRawSession('existing-1') as SessionWithMeta].filter(
        (item): item is SessionWithMeta => item !== null,
      ),
      currentSessionId: 'existing-1',
      messages: [],
      todos: [],
      sessionTasks: [],
      switchSession: vi.fn(async (_sessionId: string) => {}),
      updateSessionEngine: vi.fn(async () => {}),
    },
  };
  const deps: SessionCreateDeps = {
    get: () => holder.state,
    set: (partial) => {
      const patch = typeof partial === 'function' ? partial(holder.state) : partial;
      holder.state = { ...holder.state, ...patch };
    },
    invalidatePendingSessionSwitches: () => {},
    findReusableNewSessionDraft: () => reusable,
  };
  return { getState: () => holder.state, deps };
}

function createCallPayload(): Record<string, unknown> {
  const call = mockDomainInvoke.mock.calls.find(([, action]) => action === 'create');
  return (call?.[2] ?? {}) as Record<string, unknown>;
}

describe('executeCreateSession 的「不用记忆」档接线', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).window = {
      domainAPI: { invoke: mockDomainInvoke },
    };
    // 回到干净草稿槽：上一条用例可能已把槽 handoff 给会话
    useComposerStore.getState().activateScope(DRAFT_SCOPE_KEY);
    useComposerStore.getState().setDraftMemoryOff(false);
  });

  it('草稿槽开着 → create 载荷带 memoryMode=off', async () => {
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'create') return { success: true, data: makeRawSession('new-memory-off') };
      return { success: true, data: null };
    });
    const { deps } = buildHarness(null);
    useComposerStore.getState().setDraftMemoryOff(true);

    await executeCreateSession(deps, '帮我看看这个项目');

    expect(createCallPayload()).toMatchObject({ memoryMode: 'off' });
  });

  it('没开 → 载荷不带 memoryMode（普通会话行为不变）', async () => {
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'create') return { success: true, data: makeRawSession('new-plain') };
      return { success: true, data: null };
    });
    const { deps } = buildHarness(null);

    await executeCreateSession(deps, '帮我看看这个项目');

    expect(createCallPayload()).not.toHaveProperty('memoryMode');
  });

  it('复用空白草稿 → 绕过 create 后补 update 落档，本地列表同步为 off', async () => {
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      // 复用路径不触 create；update 是这条路径的唯一落档通道
      if (action === 'create') throw new Error('create must not be called on the reuse path');
      return { success: true, data: null };
    });
    const reusable = makeRawSession('reuse-blank', { title: '新对话' }) as SessionWithMeta;
    const { getState, deps } = buildHarness(reusable);
    useComposerStore.getState().setDraftMemoryOff(true);

    await executeCreateSession(deps); // 缺省标题「新对话」才会走复用分支

    const updateCall = mockDomainInvoke.mock.calls.find(([, action]) => action === 'update');
    expect(updateCall?.[2]).toEqual({
      sessionId: 'reuse-blank',
      updates: { memoryMode: 'off' },
    });
    expect(getState().sessions.find((item) => item.id === 'reuse-blank')?.memoryMode).toBe('off');
  });

  it('复用的空白会话已是 off → 不再发 update（幂等）', async () => {
    const reusable = makeRawSession('reuse-off', { title: '新对话', memoryMode: 'off' }) as SessionWithMeta;
    const { getState, deps } = buildHarness(reusable);
    useComposerStore.getState().setDraftMemoryOff(true);

    await executeCreateSession(deps);

    expect(mockDomainInvoke.mock.calls.some(([, action]) => action === 'update')).toBe(false);
    expect(getState().sessions.find((item) => item.id === 'reuse-off')?.memoryMode).toBe('off');
  });

  it('会话槽内新建（非草稿发起）→ 不带草稿标记，载荷不带 memoryMode', async () => {
    mockDomainInvoke.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'create') return { success: true, data: makeRawSession('new-from-session') };
      return { success: true, data: null };
    });
    const { deps } = buildHarness(null);
    // 模拟已在会话槽里点新建：标记残留在草稿槽也不许串档
    useComposerStore.getState().setDraftMemoryOff(true);
    useComposerStore.getState().activateScope('session:existing-1' as `session:${string}`);

    await executeCreateSession(deps, '帮我看看这个项目');

    expect(createCallPayload()).not.toHaveProperty('memoryMode');
  });
});

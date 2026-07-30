// @vitest-environment jsdom
// ============================================================================
// ux-round2 20e：新会话不默认选中专家
// ① 软删除最后一个会话回到 draft 时，per-session agent / workbench 选择清零
//    （此前残留会被下一次 createSession 的 inheritCurrent 写进新会话）；
// ② draft 态点「新任务」主动清掉 draft 选择；非 draft 态不动当前会话的选择。
// ============================================================================
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { useSessionUIStore } from '../../../src/renderer/stores/sessionUIStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useSidebarSessionActions } from '../../../src/renderer/components/features/sidebar/useSidebarSessionActions';
import { zh } from '../../../src/renderer/i18n/zh';
import type { Message, Session, TodoItem } from '../../../src/shared/contract';

const mockDomainInvoke = vi.fn();
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

function resetStores(sessionIds: string[]) {
  useSessionStore.setState({
    sessions: sessionIds.map((id) => ({
      ...makeSession(id),
      messageCount: 0,
      turnCount: 0,
    })) as unknown as ReturnType<typeof useSessionStore.getState>['sessions'],
    currentSessionId: null,
    messages: [],
    todos: [],
    sessionTasks: [],
    streamSnapshot: null,
    isLoading: false,
    error: null,
    sessionDesignBriefs: new Map(),
  });
  useAppStore.setState({
    activeAgentId: null,
    activeAgentSessionKey: null,
    workbenchTabs: [],
    activeWorkbenchTab: null,
    workbenchBySession: {},
    workbenchSessionKey: null,
  });
  useSessionUIStore.setState({ pendingDelete: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  (globalThis as Record<string, unknown>).window = {
    domainAPI: { invoke: mockDomainInvoke },
    electronAPI: { invoke: vi.fn(), on: vi.fn(() => () => {}), off: vi.fn() },
  };
  mockDomainInvoke.mockImplementation(async (_domain: string, op: string, params?: { sessionId?: string }) => {
    if (op === 'load') return makeSession(params?.sessionId || 'session-a');
    if (op === 'getSessionTasks') return [];
    if (op === 'delete') return { success: true };
    return null;
  });
});

describe('20e：新会话不默认选中专家', () => {
  it('软删除最后一个会话回到 draft → agent / workbench 选择归零', async () => {
    resetStores(['session-only']);
    localStorage.setItem(SESSION_MAP_KEY, JSON.stringify({ 'session-only': 'coder' }));
    await useSessionStore.getState().switchSession('session-only');
    expect(useAppStore.getState().activeAgentId).toBe('coder');
    useAppStore.getState().openWorkbenchTab('overview');

    useSessionUIStore.getState().softDelete(['session-only']);

    expect(useSessionStore.getState().currentSessionId).toBeNull();
    expect(useAppStore.getState().activeAgentId).toBeNull();
    expect(useAppStore.getState().activeAgentSessionKey).toBeNull();
    expect(useAppStore.getState()).toMatchObject({
      workbenchTabs: [],
      activeWorkbenchTab: null,
      workbenchSessionKey: null,
    });
  });

  it('draft 态点「新任务」→ 清掉 draft 期残留的专家选择', async () => {
    resetStores([]);
    // draft 残留：activeAgentId 在内存但没有会话归属
    useAppStore.setState({ activeAgentId: 'coder', activeAgentSessionKey: null });

    const createSession = vi.fn(async () => null);
    const { result } = renderHook(() => useSidebarSessionActions({
      collapseTimersRef: { current: {} },
      setCollapsingWorkspaces: vi.fn(),
      setWorkspaceExpanded: vi.fn(),
      isCreatingSession: false,
      creatingWorkspaceKey: null,
      setCreatingSessionMode: vi.fn(),
      setCreatingWorkspaceKey: vi.fn(),
      createSession,
      clearPlanningState: vi.fn(),
      setWorkingDirectory: vi.fn(),
      multiSelectMode: false,
      toggleSelection: vi.fn(),
      searchQuery: '',
      messageSearchHitsBySessionId: {},
      setPendingSearchJump: vi.fn(),
      currentSessionId: null,
      switchSession: vi.fn(),
      unarchiveSession: vi.fn(),
      archiveSession: vi.fn(),
      openWorkspacePreview: vi.fn(),
      setProjectMetaById: vi.fn(),
      t: zh,
    }));

    await act(async () => { await result.current.handleNewChat(); });

    expect(createSession).toHaveBeenCalled();
    expect(useAppStore.getState().activeAgentId).toBeNull();
  });

  it('有当前会话时点「新任务」→ 不动当前会话的专家绑定', async () => {
    resetStores(['session-a']);
    localStorage.setItem(SESSION_MAP_KEY, JSON.stringify({ 'session-a': 'coder' }));
    await useSessionStore.getState().switchSession('session-a');
    expect(useAppStore.getState().activeAgentId).toBe('coder');

    const createSession = vi.fn(async () => null);
    const { result } = renderHook(() => useSidebarSessionActions({
      collapseTimersRef: { current: {} },
      setCollapsingWorkspaces: vi.fn(),
      setWorkspaceExpanded: vi.fn(),
      isCreatingSession: false,
      creatingWorkspaceKey: null,
      setCreatingSessionMode: vi.fn(),
      setCreatingWorkspaceKey: vi.fn(),
      createSession,
      clearPlanningState: vi.fn(),
      setWorkingDirectory: vi.fn(),
      multiSelectMode: false,
      toggleSelection: vi.fn(),
      searchQuery: '',
      messageSearchHitsBySessionId: {},
      setPendingSearchJump: vi.fn(),
      currentSessionId: 'session-a',
      switchSession: vi.fn(),
      unarchiveSession: vi.fn(),
      archiveSession: vi.fn(),
      openWorkspacePreview: vi.fn(),
      setProjectMetaById: vi.fn(),
      t: zh,
    }));

    await act(async () => { await result.current.handleNewChat(); });

    // 当前会话的 per-session 绑定原样保留（切回去仍恢复它的专家）
    expect(useAppStore.getState().activeAgentId).toBe('coder');
    expect(JSON.parse(localStorage.getItem(SESSION_MAP_KEY) || '{}')).toEqual({ 'session-a': 'coder' });
  });
});

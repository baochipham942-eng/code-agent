// @vitest-environment jsdom
// 回归测试：活动轮里 sidebar 项目摘要 effect 不得随每条 SSE 事件重拉。
//
// 根因（曾）：项目摘要 effect 依赖 `visibleProjectIds`（每次渲染新数组引用），
// 活动轮里每条 SSE 事件都会 updateSessionState → 重建 workspaceGroupedSessions →
// visibleProjectIds 变新引用（内容不变）→ effect 误判依赖变化 → 每个 token 重拉
// project detail/artifacts，几百次请求打爆 socket 池（ERR_INSUFFICIENT_RESOURCES）。
// 修法：依赖内容稳定的 join key，与同文件 visibleSessionIdsKey 同款。
//
// 本测试：挂载 hook（一个可见项目）→ 记录初次 detail/artifacts 拉取次数 →
// 模拟一次「project-id 集合不变」的 store 更新触发重渲 → 断言拉取次数不再增长。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// ---- store 状态（selector-mock 读取，测试内可变更后 rerender）----
const state = vi.hoisted(() => ({
  session: {
    sessions: [] as any[],
    currentSessionId: null as string | null,
    sessionRuntimes: new Map<string, unknown>(),
    backgroundSessions: [] as any[],
    pendingUserQuestionsBySessionId: new Map<string, unknown>(),
  },
  ui: {
    searchQuery: '',
    sessionStatusFilter: 'all' as const,
    trajectoryTierFilter: 'all' as const,
    trajectoryFailureFilter: 'all' as const,
    trajectoryReviewFilter: 'all' as const,
  },
  app: {
    pendingPermissionRequest: null as unknown,
    pendingPermissionSessionId: null as string | null,
    queuedPermissionRequests: [] as unknown[],
  },
  backgroundTask: { tasks: [] as unknown[] },
  workflow: { runs: [] as unknown[] },
  task: { sessionStates: {} as Record<string, { status: string }> },
}));

const projectClient = vi.hoisted(() => ({
  getProjectDetail: vi.fn(async (projectId: string) => ({
    project: { id: projectId, name: 'P', status: 'active', description: '', updatedAt: 1 },
    goals: [],
    roles: [],
    sessionIds: ['s1'],
  })),
  getProjectArtifacts: vi.fn(async () => []),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: (s: unknown) => unknown) => sel(state.session),
}));
vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: (sel: (s: unknown) => unknown) => sel(state.ui),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (sel: (s: unknown) => unknown) => sel(state.app),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (sel: (s: unknown) => unknown) => sel(state.backgroundTask),
}));
vi.mock('../../../src/renderer/stores/workflowStore', () => ({
  useWorkflowStore: (sel: (s: unknown) => unknown) => sel(state.workflow),
}));
vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (sel: (s: unknown) => unknown) => sel(state.task),
}));
vi.mock('../../../src/renderer/services/projectClient', () => projectClient);
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { useSidebarDerivedSessions } from '../../../src/renderer/components/features/sidebar/useSidebarDerivedSessions';

beforeEach(() => {
  vi.clearAllMocks();
  state.session.sessions = [
    {
      id: 's1',
      projectId: 'proj_x',
      workingDirectory: '/w',
      status: 'active',
      messageCount: 1,
      turnCount: 1,
      updatedAt: 1,
    },
  ];
  state.session.sessionRuntimes = new Map();
  state.session.backgroundSessions = [];
  state.task.sessionStates = {};
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('sidebar 项目摘要请求风暴回归', () => {
  it('project-id 集合不变的 store 更新不重拉 detail/artifacts', async () => {
    const { rerender } = renderHook(() => useSidebarDerivedSessions({ canOpenSessionReplay: false }));

    // 初次挂载：可见项目 proj_x → 各拉一次
    await waitFor(() => expect(projectClient.getProjectDetail).toHaveBeenCalledTimes(1));
    expect(projectClient.getProjectArtifacts).toHaveBeenCalledTimes(1);

    // 模拟活动轮 SSE 事件：sessionStates 换新对象（引用变、项目集合不变）
    for (let i = 0; i < 10; i++) {
      state.task.sessionStates = { s1: { status: i % 2 === 0 ? 'running' : 'active' } };
      rerender();
    }
    await waitFor(() => expect(true).toBe(true));

    // 修复前：每次重渲都重拉 → 次数暴涨；修复后：集合未变 → 仍为 1
    expect(projectClient.getProjectDetail).toHaveBeenCalledTimes(1);
    expect(projectClient.getProjectArtifacts).toHaveBeenCalledTimes(1);
  });

  it('项目集合真变化时仍重拉（不误伤正常刷新）', async () => {
    const { rerender } = renderHook(() => useSidebarDerivedSessions({ canOpenSessionReplay: false }));
    await waitFor(() => expect(projectClient.getProjectDetail).toHaveBeenCalledTimes(1));

    // 新增一个不同项目的会话 → visibleProjectIds 集合变化 → 应重拉
    state.session.sessions = [
      ...state.session.sessions,
      {
        id: 's2',
        projectId: 'proj_y',
        workingDirectory: '/w2',
        status: 'active',
        messageCount: 1,
        turnCount: 1,
        updatedAt: 2,
      },
    ];
    rerender();

    await waitFor(() => expect(projectClient.getProjectDetail).toHaveBeenCalledWith('proj_y'));
  });
});

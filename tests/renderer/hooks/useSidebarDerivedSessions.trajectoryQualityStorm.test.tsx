// @vitest-environment jsdom
// 回归测试：活动轮里 sidebar 的 trajectory quality effect 不得随每条 SSE 事件重拉。
//
// 与 useSidebarDerivedSessions.projectSummaryStorm.test.tsx 是同一个病的姊妹例——
// 那次只修了 visibleProjectIds，同文件的 trajectory quality effect 漏网：它已经算好了
// 内容稳定的 trajectoryQualityCandidateKey，却又把派生数组 trajectoryQualityCandidateSessionIds
// 一起放进依赖数组，key 的去重被彻底废掉。
//
// 真机后果（2026-08-01 取证）：流式期间 8 秒发了 50 次 get-quality-summary（约 160ms 一次），
// 且 cleanup 不取消在飞请求，把浏览器对同一 origin 的连接池（HTTP/1.1 上限 6，SSE 已占 1）打满。
// 之后普通请求排队永远轮不上——用户在运行中发消息时，ensureModelConfigured 的 settings/get
// 挂死不返回，而输入框在发送前就已清空，整条消息在屏幕/messages/queued_inputs 三处无痕。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

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

const ipc = vi.hoisted(() => ({ invoke: vi.fn(async () => ({})) }));
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
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: ipc }));
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { useSidebarDerivedSessions } from '../../../src/renderer/components/features/sidebar/useSidebarDerivedSessions';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const qualityCalls = () =>
  ipc.invoke.mock.calls.filter((call) => call[0] === IPC_CHANNELS.REPLAY_GET_TRAJECTORY_QUALITY).length;

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

describe('sidebar trajectory quality 请求风暴回归', () => {
  it('候选会话集合不变的 store 更新不重拉 quality', async () => {
    const { rerender } = renderHook(() => useSidebarDerivedSessions({ canOpenSessionReplay: true }));

    await waitFor(() => expect(qualityCalls()).toBe(1));

    // 模拟活动轮 SSE 事件：sessionStates 每次换新对象（引用变、候选集合不变）
    for (let i = 0; i < 10; i += 1) {
      state.task.sessionStates = { s1: { status: i % 2 === 0 ? 'running' : 'active' } };
      rerender();
    }
    await waitFor(() => expect(true).toBe(true));

    // 修复前：依赖数组带着派生数组引用 → 每次重渲都重拉 → 11 次；修复后：仍为 1
    expect(qualityCalls()).toBe(1);
  });

  it('候选集合真变化时仍重拉（不误伤正常刷新）', async () => {
    const { rerender } = renderHook(() => useSidebarDerivedSessions({ canOpenSessionReplay: true }));
    await waitFor(() => expect(qualityCalls()).toBe(1));

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

    await waitFor(() => expect(qualityCalls()).toBe(2));
    const last = ipc.invoke.mock.calls
      .filter((call) => call[0] === IPC_CHANNELS.REPLAY_GET_TRAJECTORY_QUALITY)
      .at(-1);
    expect((last?.[1] as { sessionIds: string[] }).sessionIds).toContain('s2');
  });
});

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const sessionState = {
  sessions: [
    {
      id: 'session-1',
      title: 'Session Native Workspace',
      modelConfig: { provider: 'openai', model: 'gpt-5.4' },
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 5_000,
      workingDirectory: '/repo/code-agent',
      gitBranch: 'feature/sidebar-recovery',
      prLink: {
        owner: 'linchen',
        repo: 'code-agent',
        number: 17,
        title: 'Project sidebar recovery hints',
        linkedAt: Date.now() - 4_000,
      },
      messageCount: 9,
      turnCount: 3,
      workbenchSnapshot: {
        summary: '工作区 · Browser',
        labels: ['工作区', 'Browser'],
        recentToolNames: ['browser_action'],
      },
    },
    {
      id: 'session-2',
      title: 'Finished Session',
      modelConfig: { provider: 'openai', model: 'gpt-4.1-mini' },
      createdAt: Date.now() - 25_000,
      updatedAt: Date.now() - 15_000,
      workingDirectory: '/repo/archive',
      messageCount: 6,
      turnCount: 2,
      workbenchSnapshot: {
        summary: '纯对话',
        labels: ['纯对话'],
        recentToolNames: [],
      },
    },
    {
      id: 'session-appshot',
      title: '<appshot app="com.apple.finder" name="Finder">',
      modelConfig: { provider: 'openai', model: 'gpt-4.1-mini' },
      createdAt: Date.now() - 35_000,
      updatedAt: Date.now() - 30_000,
      workingDirectory: '/repo/archive',
      messageCount: 2,
      turnCount: 1,
      workbenchSnapshot: {
        summary: '纯对话',
        labels: ['纯对话'],
        recentToolNames: [],
      },
    },
  ] as any[],
  currentSessionId: 'session-1',
  messages: [] as any[],
  todos: [] as any[],
  isLoading: false,
  createSession: vi.fn(async () => null),
  switchSession: vi.fn(async () => {}),
  archiveSession: vi.fn(async () => {}),
  unarchiveSession: vi.fn(async () => {}),
  unreadSessionIds: new Set<string>(),
  sessionRuntimes: new Map(),
  backgroundTasks: [
    {
      sessionId: 'session-1',
      title: 'Session Native Workspace',
      startedAt: Date.now() - 20_000,
      backgroundedAt: Date.now() - 8_000,
      status: 'running',
    },
  ],
  renameSession: vi.fn(async () => {}),
};

const selectionState = {
  pinnedSessionIds: new Set<string>(),
  togglePin: vi.fn(),
  multiSelectMode: false,
  toggleMultiSelect: vi.fn(),
  selectedSessionIds: new Set<string>(),
  toggleSelection: vi.fn(),
  clearSelection: vi.fn(),
  batchDelete: vi.fn(),
};

const sessionUiState = {
  filter: 'active',
  setFilter: vi.fn(),
  searchQuery: '',
  setSearchQuery: vi.fn(),
  sessionStatusFilter: 'all' as 'all' | 'unfinished' | 'approval' | 'running' | 'attention' | 'artifact' | 'review' | 'background',
  setSessionStatusFilter: vi.fn(),
  trajectoryTierFilter: 'all',
  setTrajectoryTierFilter: vi.fn(),
  trajectoryFailureFilter: 'all',
  setTrajectoryFailureFilter: vi.fn(),
  trajectoryReviewFilter: 'all',
  setTrajectoryReviewFilter: vi.fn(),
  pendingSearchJump: null,
  setPendingSearchJump: vi.fn(),
  expandedWorkspaces: {} as Record<string, boolean>,
  setWorkspaceExpanded: vi.fn(),
  softDelete: vi.fn(),
  undoDelete: vi.fn(),
  pendingDelete: null,
};

const appState = {
  clearPlanningState: vi.fn(),
  setShowSettings: vi.fn(),
  openSettingsTab: vi.fn(),
  setShowEvalCenter: vi.fn(),
  openWorkspacePreview: vi.fn(),
  pendingPermissionRequest: null as unknown,
  pendingPermissionSessionId: null as string | null,
  queuedPermissionRequests: {} as Record<string, any[]>,
};

const authState = {
  user: null,
  isAuthenticated: false,
  setShowAuthModal: vi.fn(),
  signOut: vi.fn(async () => {}),
};

const workflowState = {
  runs: {} as Record<string, any>,
  activeRunId: undefined as string | undefined,
  launchRequests: [] as any[],
};

const backgroundTaskState = {
  tasks: [] as any[],
};

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: typeof sessionState) => unknown) => selector ? selector(sessionState) : sessionState,
  initializeSessionStore: vi.fn(async () => {}),
}));

vi.mock('../../../src/renderer/stores/selectionStore', () => ({
  useSelectionStore: (selector?: (state: typeof selectionState) => unknown) => selector ? selector(selectionState) : selectionState,
}));

vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: (selector?: (state: typeof sessionUiState) => unknown) => selector ? selector(sessionUiState) : sessionUiState,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
}));

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector?: (state: typeof authState) => unknown) => selector ? selector(authState) : authState,
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: { sessionStates: Record<string, unknown> }) => unknown) =>
    selector ? selector({ sessionStates: { 'session-1': { status: 'running' } } }) : { sessionStates: { 'session-1': { status: 'running' } } },
}));

vi.mock('../../../src/renderer/stores/workflowStore', () => ({
  useWorkflowStore: (selector?: (state: typeof workflowState) => unknown) =>
    selector ? selector(workflowState) : workflowState,
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector?: (state: typeof backgroundTaskState) => unknown) =>
    selector ? selector(backgroundTaskState) : backgroundTaskState,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
    on: vi.fn(),
  },
}));

import { Sidebar } from '../../../src/renderer/components/Sidebar';

describe('Sidebar session metadata', () => {
  beforeEach(() => {
    authState.user = null;
    sessionUiState.searchQuery = '';
    sessionUiState.sessionStatusFilter = 'all';
    sessionUiState.trajectoryTierFilter = 'all';
    sessionUiState.trajectoryFailureFilter = 'all';
    sessionUiState.trajectoryReviewFilter = 'all';
    appState.pendingPermissionRequest = null;
    appState.pendingPermissionSessionId = null;
    appState.queuedPermissionRequests = {};
    sessionUiState.expandedWorkspaces = {};
    workflowState.runs = {};
    workflowState.activeRunId = undefined;
    workflowState.launchRequests = [];
    backgroundTaskState.tasks = [];
  });

  it('renders session-native status, turn count, and workbench snapshot', () => {
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('Session Native Workspace');
    expect(html).toContain('执行中');
    expect(html).not.toContain('已完成');
    // commit bce470a2 把 turnCount 显示从 Sidebar 二级信息行移除，改用
    // workbenchSnapshot.summary 占据该位置（"工作区 · Browser"）。turnCount 仍保留
    // 在 store 用于排序/统计，但不再直接渲染。下面对 snapshot summary 的断言已覆盖。
    expect(html).toContain('工作区 · Browser');
    expect(html).toContain('aria-label="在 code-agent 新建会话"');
    expect(html).toContain('aria-label="打开 code-agent 项目控制台"');
    expect(html).toContain('aria-label="展开 code-agent 项目详情"');
    expect(html).toContain('aria-label="打开 code-agent 产物与资产"');
    expect(html).toContain('aria-label="打开 Session Native Workspace 的产物与资产"');
    // 2026-07-02 分组头未完成态改为右对齐"色球+数字"(title/aria 带全文)，不再渲染"N 未完成"文字胶囊
    expect(html).toContain('1 个未完成');
    expect(html).not.toContain('1 未完成');
    expect(html).toContain('1 执行中');
    expect(html).toContain('1 会话');
    expect(html).toContain('repo/code-agent');
    expect(html).toContain('sidebar-recovery');
    expect(html).toContain('PR #17');
    expect(html).toContain('产物');
  });

  it('exposes the status filter entry (icon dropdown) for admins', () => {
    // 状态筛选已从一整排 tab 收成「新会话」右侧的一个筛选图标 + 下拉（仅管理员）。
    authState.user = { isAdmin: true };
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('按状态筛选会话'); // 筛选图标按钮 aria-label
  });

  it('surfaces the active trajectory pending-review filter for admins', () => {
    authState.user = { isAdmin: true };
    sessionUiState.sessionStatusFilter = 'review';
    sessionUiState.trajectoryReviewFilter = 'pending';

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('状态筛选：待审 · 待复核');
  });

  it('hides the status filter entry for non-admin users (D-10)', () => {
    const html = renderToStaticMarkup(React.createElement(Sidebar));
    // 普通用户只留搜索框，连筛选图标都不渲染。
    expect(html).not.toContain('按状态筛选会话');
    expect(html).toContain('搜索会话...'); // 搜索框仍在
  });

  it('supports the background-only quick filter', () => {
    sessionUiState.sessionStatusFilter = 'background';

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('执行中');
    expect(html).toContain('Session Native Workspace');
    expect(html).not.toContain('Finished Session');
  });

  it('filters sessions with delivery recovery signals without dropping project grouping', () => {
    sessionUiState.sessionStatusFilter = 'artifact';
    const originalSessions = sessionState.sessions;
    sessionState.sessions = sessionState.sessions.map((session) =>
      session.id === 'session-1'
        ? {
            ...session,
            workbenchSnapshot: {
              ...session.workbenchSnapshot,
              primarySurface: 'workspace',
              recentToolNames: ['Write'],
            },
          }
        : session,
    );

    try {
      const html = renderToStaticMarkup(React.createElement(Sidebar));

      expect(html).toContain('Session Native Workspace');
      // D-10: 普通用户看不到状态筛选 tab，但程序化设置的筛选仍生效。
      expect(html).not.toContain('交付线索');
      expect(html).toContain('产物');
      expect(html).toContain('aria-label="在 code-agent 新建会话"');
      expect(html).not.toContain('Finished Session');
    } finally {
      sessionState.sessions = originalSessions;
      sessionUiState.sessionStatusFilter = 'all';
    }
  });

  it('keeps a collapsed current project visible with an explicit protection state', () => {
    sessionUiState.expandedWorkspaces = {
      '/repo/code-agent': false,
      '/repo/archive': false,
    };

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('data-sidebar-group-phase="forced-expanded"');
    expect(html).toContain('aria-label="code-agent 保持展开');
    expect(html).toContain('保持展开');
    expect(html).toContain('Session Native Workspace');
    expect(html).not.toContain('Finished Session');
  });

  it('filters pending approval sessions without dropping project grouping', () => {
    sessionUiState.sessionStatusFilter = 'approval';
    appState.queuedPermissionRequests = {
      'session-2': [{ id: 'perm-1', tool: 'bash' }],
    };

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('Finished Session');
    expect(html).toContain('待确认');
    expect(html).toContain('aria-label="在 archive 新建会话"');
    expect(html).not.toContain('Session Native Workspace');
  });

  it('keeps project grouping while searching sessions', () => {
    sessionUiState.searchQuery = 'Session Native';

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('Session Native Workspace');
    expect(html).toContain('当前项目');
    expect(html).toContain('全部');
    expect(html).toContain('aria-label="在 code-agent 新建会话"');
    expect(html).toContain('1 命中');
    expect(html).not.toContain('Finished Session');
  });

  it('renders one project group for sessions sharing projectId across worktrees', () => {
    const originalSessions = sessionState.sessions;
    const originalCurrentSessionId = sessionState.currentSessionId;
    sessionState.sessions = [
      {
        ...originalSessions[0],
        id: 'project-main',
        title: 'Main Project Task',
        workingDirectory: '/repo/code-agent',
        projectId: 'proj-code-agent',
        updatedAt: Date.now() - 30_000,
      },
      {
        ...originalSessions[1],
        id: 'project-worktree',
        title: 'Worktree Follow Up',
        workingDirectory: '/repo/code-agent-worktree',
        projectId: 'proj-code-agent',
        updatedAt: Date.now() - 5_000,
      },
    ];
    sessionState.currentSessionId = 'project-main';
    sessionUiState.expandedWorkspaces = {
      'project:proj-code-agent': true,
      '/repo/code-agent': false,
      '/repo/code-agent-worktree': false,
    };

    try {
      const html = renderToStaticMarkup(React.createElement(Sidebar));

      expect(html).toContain('data-sidebar-group-rows="project:proj-code-agent"');
      expect(html).not.toContain('data-sidebar-group-rows="/repo/code-agent"');
      expect(html).not.toContain('data-sidebar-group-rows="/repo/code-agent-worktree"');
      expect(html).toContain('Main Project Task');
      expect(html).toContain('Worktree Follow Up');
      expect(html).toContain('repo/code-agent-worktree +1 工作区');
      expect(html.match(/data-sidebar-group-rows=/g) ?? []).toHaveLength(1);
    } finally {
      sessionState.sessions = originalSessions;
      sessionState.currentSessionId = originalCurrentSessionId;
    }
  });

  it('surfaces session-specific permission queues as pending confirmation', () => {
    appState.queuedPermissionRequests = {
      'session-2': [{ id: 'perm-1', tool: 'bash' }],
    };

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('Finished Session');
    expect(html).toContain('待确认');
  });

  it('raises older actionable sessions above newer completed sessions in the same project group', () => {
    const originalSessions = sessionState.sessions;
    sessionState.sessions = sessionState.sessions.map((session) => {
      if (session.id === 'session-2') {
        return {
          ...session,
          updatedAt: Date.now() - 90_000,
          status: 'completed',
        };
      }
      if (session.id === 'session-appshot') {
        return {
          ...session,
          updatedAt: Date.now() - 5_000,
          status: 'completed',
        };
      }
      return session;
    });
    appState.queuedPermissionRequests = {
      'session-2': [{ id: 'perm-1', tool: 'bash' }],
    };

    try {
      const html = renderToStaticMarkup(React.createElement(Sidebar));
      const approvalIndex = html.indexOf('Finished Session');
      const completedIndex = html.indexOf('Appshot 会话');

      expect(approvalIndex).toBeGreaterThan(-1);
      expect(completedIndex).toBeGreaterThan(-1);
      expect(approvalIndex).toBeLessThan(completedIndex);
    } finally {
      sessionState.sessions = originalSessions;
    }
  });

  it('keeps current and unfinished project groups visible even when persisted state says collapsed', () => {
    sessionUiState.expandedWorkspaces = {
      '/repo/code-agent': false,
      '/repo/archive': false,
    };

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('Session Native Workspace');
    expect(html).toContain('data-sidebar-group-phase="forced-expanded"');
    expect(html).toContain('当前会话所在项目保持展开');
    expect(html).toContain('保持展开');
    expect(html).not.toContain('Finished Session');
    expect(html).not.toContain('Appshot 会话');
  });

  it('does not expose appshot XML in session titles', () => {
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('Appshot 会话');
    expect(html).not.toContain('&lt;appshot');
    expect(html).not.toContain('<appshot');
  });

  it('surfaces workflow replay signals in the delivery recovery filter', () => {
    sessionUiState.sessionStatusFilter = 'artifact';
    workflowState.runs = {
      'workflow-run-1': {
        runId: 'workflow-run-1',
        sessionId: 'session-2',
        status: 'completed',
        goal: 'Recover project delivery',
        phases: [],
        logs: [],
        agents: [],
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
    };
    workflowState.activeRunId = 'workflow-run-1';

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('Finished Session');
    expect(html).not.toContain('交付线索'); // D-10: 非管理员隐藏筛选 tab，筛选仍程序化生效
    expect(html).toContain('Replay');
    expect(html).toContain('Workflow replay');
    expect(html).toContain('Recover project delivery');
    expect(html).toContain('结构化 Replay 仅管理员可打开');
    expect(html).not.toContain('Session Native Workspace');
    expect(html).not.toContain('&lt;appshot');
  });

  it('renders concrete background trace and replay evidence in the session row', () => {
    sessionUiState.sessionStatusFilter = 'artifact';
    backgroundTaskState.tasks = [{
      id: 'task-1',
      sessionId: 'session-2',
      source: 'agent',
      title: 'Background delivery',
      status: 'completed',
      createdAt: Date.now() - 20_000,
      updatedAt: Date.now() - 10_000,
      events: [],
      outputRefs: [
        {
          id: 'replay-ref',
          taskId: 'task-1',
          type: 'replay',
          label: 'background replay',
          uri: 'replay://task-1',
          createdAt: Date.now() - 10_000,
        },
        {
          id: 'trace-ref',
          taskId: 'task-1',
          type: 'trace',
          label: 'trace.json',
          path: '/tmp/trace.json',
          createdAt: Date.now() - 10_000,
        },
      ],
    }];

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('Finished Session');
    expect(html).not.toContain('交付线索'); // D-10: 非管理员隐藏筛选 tab，筛选仍程序化生效
    expect(html).toContain('background replay');
    expect(html).toContain('trace.json');
    expect(html).toContain('/tmp/trace.json');
    expect(html).not.toContain('Session Native Workspace');
  });
});

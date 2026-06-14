 
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';

const reactState = vi.hoisted(() => ({
  forcedContextMenuSession: null as any,
  forcedReviewItemsBySessionId: null as Record<string, Array<{ reviewStatus: string; title: string }>> | null,
  useStateCalls: 0,
}));

const menuState = vi.hoisted(() => ({
  items: [] as Array<{ label: string; onClick: () => void | Promise<void>; disabled?: boolean }>,
}));

const invokeMock = vi.hoisted(() => vi.fn());
const domainInvokeMock = vi.hoisted(() => vi.fn());
const setShowEvalCenterMock = vi.hoisted(() => vi.fn());
const setWorkingDirectoryMock = vi.hoisted(() => vi.fn());
const applySessionWorkbenchPresetMock = vi.hoisted(() => vi.fn());
const applyWorkbenchPresetMock = vi.hoisted(() => vi.fn());
const applyWorkbenchRecipeMock = vi.hoisted(() => vi.fn());
const saveWorkbenchPresetFromSessionMock = vi.hoisted(() => vi.fn());
const promptMock = vi.hoisted(() => vi.fn());
const clipboardWriteTextMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());
const workbenchPresetState = vi.hoisted(() => ({
  presets: [] as any[],
  recipes: [] as any[],
  savePresetFromSession: saveWorkbenchPresetFromSessionMock,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (initial: unknown) => {
      reactState.useStateCalls += 1;
      if (reactState.forcedContextMenuSession && reactState.useStateCalls === 7) {
        return [
          { x: 24, y: 24, session: reactState.forcedContextMenuSession },
          vi.fn(),
        ] as const;
      }
      if (reactState.forcedReviewItemsBySessionId && reactState.useStateCalls === 11) {
        return [
          reactState.forcedReviewItemsBySessionId,
          vi.fn(),
        ] as const;
      }
      return actual.useState(initial);
    },
  };
});

const sessionState = {
  sessions: [
    {
      id: 'session-1',
      title: 'Reviewable Session',
      modelConfig: { provider: 'openai', model: 'gpt-5.4' },
      createdAt: Date.now() - 10_000,
      updatedAt: Date.now() - 5_000,
      workingDirectory: '/repo/code-agent',
      messageCount: 9,
      turnCount: 3,
      workbenchSnapshot: {
        summary: '工作区 · Browser',
        labels: ['工作区', 'Browser'],
        recentToolNames: ['browser_action'],
        routingMode: 'parallel',
        skillIds: ['review-skill'],
        connectorIds: ['mail'],
        mcpServerIds: ['github'],
      },
      workbenchProvenance: {
        capturedAt: Date.now() - 4_000,
        workingDirectory: '/repo/code-agent',
        routingMode: 'direct',
        targetAgentIds: ['agent-1'],
        selectedSkillIds: ['review-skill'],
        selectedConnectorIds: ['mail'],
        selectedMcpServerIds: ['github'],
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
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
  backgroundTasks: [] as any[],
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
  pendingSearchJump: null,
  setPendingSearchJump: vi.fn(),
  softDelete: vi.fn(),
  undoDelete: vi.fn(),
  pendingDelete: null,
  expandedWorkspaces: {},
  setWorkspaceExpanded: vi.fn(),
};

const appState = {
  clearPlanningState: vi.fn(),
  setShowSettings: vi.fn(),
  openSettingsTab: vi.fn(),
  setShowEvalCenter: setShowEvalCenterMock,
  setWorkingDirectory: setWorkingDirectoryMock,
};

const authState = {
  user: null as { isAdmin?: boolean } | null,
  isAuthenticated: false,
  setShowAuthModal: vi.fn(),
  signOut: vi.fn(async () => {}),
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

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: (selector?: (state: {
    applySessionWorkbenchPreset: typeof applySessionWorkbenchPresetMock;
    applyWorkbenchPreset: typeof applyWorkbenchPresetMock;
    applyWorkbenchRecipe: typeof applyWorkbenchRecipeMock;
  }) => unknown) =>
    selector
      ? selector({
          applySessionWorkbenchPreset: applySessionWorkbenchPresetMock,
          applyWorkbenchPreset: applyWorkbenchPresetMock,
          applyWorkbenchRecipe: applyWorkbenchRecipeMock,
        })
      : {
          applySessionWorkbenchPreset: applySessionWorkbenchPresetMock,
          applyWorkbenchPreset: applyWorkbenchPresetMock,
          applyWorkbenchRecipe: applyWorkbenchRecipeMock,
        },
}));

vi.mock('../../../src/renderer/stores/workbenchPresetStore', () => ({
  useWorkbenchPresetStore: (selector?: (state: typeof workbenchPresetState) => unknown) =>
    selector ? selector(workbenchPresetState) : workbenchPresetState,
}));

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector?: (state: typeof authState) => unknown) => selector ? selector(authState) : authState,
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: { sessionStates: Record<string, unknown> }) => unknown) =>
    selector ? selector({ sessionStates: {} }) : { sessionStates: {} },
}));

vi.mock('../../../src/renderer/stores/uiStore', () => ({
  useUIStore: (selector?: (state: { showToast: typeof showToastMock }) => unknown) =>
    selector ? selector({ showToast: showToastMock }) : { showToast: showToastMock },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
    on: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/components/features/sidebar/SessionContextMenu', () => ({
  SessionContextMenu: ({ items }: { items: Array<{ label: string; onClick: () => void | Promise<void> }> }) => {
    menuState.items = items;
    return null;
  },
}));

import { Sidebar, resolveRuntimeLogsDir } from '../../../src/renderer/components/Sidebar';

function renderSidebarWithContextMenu() {
  reactState.useStateCalls = 0;
  reactState.forcedContextMenuSession = sessionState.sessions[0];
  menuState.items = [];
  const html = renderToStaticMarkup(React.createElement(Sidebar));
  expect(menuState.items.length).toBeGreaterThan(0);
  return html;
}

describe('Sidebar review actions', () => {
  beforeEach(() => {
    reactState.useStateCalls = 0;
    reactState.forcedContextMenuSession = null;
    reactState.forcedReviewItemsBySessionId = null;
    menuState.items = [];
    invokeMock.mockReset();
    domainInvokeMock.mockReset();
    domainInvokeMock.mockResolvedValue({ success: true, data: '/repo/code-agent' });
    setShowEvalCenterMock.mockReset();
    setWorkingDirectoryMock.mockReset();
    applySessionWorkbenchPresetMock.mockReset();
    applyWorkbenchPresetMock.mockReset();
    applyWorkbenchRecipeMock.mockReset();
    saveWorkbenchPresetFromSessionMock.mockReset();
    promptMock.mockReset();
    clipboardWriteTextMock.mockReset();
    showToastMock.mockReset();
    clipboardWriteTextMock.mockResolvedValue(undefined);
    workbenchPresetState.presets = [];
    workbenchPresetState.recipes = [];
    sessionUiState.sessionStatusFilter = 'all';
    sessionUiState.searchQuery = '';
    authState.user = null;
    Reflect.set(globalThis, 'window', {
      domainAPI: {
        invoke: domainInvokeMock,
      },
      prompt: promptMock,
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: clipboardWriteTextMock,
        },
      },
      configurable: true,
    });
  });

  it('copies the selected session id from context menu', async () => {
    renderSidebarWithContextMenu();

    const copyIdAction = menuState.items.find((item) => item.label === '复制会话 ID');
    expect(copyIdAction).toBeTruthy();

    await copyIdAction?.onClick();

    expect(clipboardWriteTextMock).toHaveBeenCalledWith('session-1');
  });

  it('keeps review queue out while showing replay as an admin-gated recovery action', () => {
    const html = renderSidebarWithContextMenu();

    expect(menuState.items.some((item) => item.label === '加入 Review')).toBe(false);
    expect(menuState.items.some((item) => item.label === '打开 Replay')).toBe(false);
    const replayAction = menuState.items.find((item) => item.label === 'Replay 仅管理员可用');
    expect(replayAction).toBeTruthy();
    expect(replayAction?.disabled).toBe(true);
    expect(html).toContain('aria-label="Replay 仅管理员可用：Reviewable Session"');
    expect(menuState.items.some((item) => item.label === '导出 JSON')).toBe(false);
  });

  it('requests structured replay from the selected session context menu for admins', async () => {
    authState.user = { isAdmin: true };
    invokeMock.mockResolvedValue({
      sessionId: 'session-1',
      traceSource: 'session_replay',
      traceIdentity: {
        traceId: 'session:session-1',
        traceSource: 'session_replay',
        source: 'session_replay',
        sessionId: 'session-1',
        replayKey: 'session-1',
      },
      dataSource: 'telemetry',
      turns: [],
      summary: {
        totalTurns: 2,
        toolDistribution: {},
        thinkingRatio: 0,
        selfRepairChains: 0,
        totalDurationMs: 1000,
      },
    });

    const html = renderSidebarWithContextMenu();

    const replayAction = menuState.items.find((item) => item.label === '打开 Replay');
    expect(replayAction).toBeTruthy();
    expect(replayAction?.disabled).not.toBe(true);
    expect(html).toContain('aria-label="打开 Reviewable Session Replay"');

    await replayAction?.onClick();

    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.REPLAY_GET_STRUCTURED_DATA, 'session-1');
    expect(showToastMock).not.toHaveBeenCalledWith('error', expect.any(String));
  });

  it('surfaces pending review evidence on the session row for admins', () => {
    authState.user = { isAdmin: true };
    reactState.forcedReviewItemsBySessionId = {
      'session-1': [
        { reviewStatus: 'pending', title: 'Missing artifact proof' },
        { reviewStatus: 'approved', title: 'Already reviewed' },
        { reviewStatus: 'pending', title: 'Replay incomplete' },
      ],
    };

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('aria-label="打开 Reviewable Session 的 Review 证据"');
    expect(html).toContain('2 待审');
    expect(html).toContain('2 个待审 issue · Missing artifact proof');
  });

  it('filters the sidebar to sessions with pending review evidence for admins', () => {
    const originalSessions = sessionState.sessions;
    authState.user = { isAdmin: true };
    sessionUiState.sessionStatusFilter = 'review';
    reactState.forcedReviewItemsBySessionId = {
      'session-1': [
        { reviewStatus: 'pending', title: 'Needs review' },
      ],
      'session-2': [
        { reviewStatus: 'approved', title: 'Already reviewed' },
      ],
    };
    sessionState.sessions = [
      ...originalSessions,
      {
        ...originalSessions[0],
        id: 'session-2',
        title: 'Reviewed Session',
        updatedAt: Date.now() - 20_000,
      },
    ];

    try {
      const html = renderToStaticMarkup(React.createElement(Sidebar));

      expect(html).toContain('Reviewable Session');
      expect(html).toContain('1 待审');
      expect(html).not.toContain('Reviewed Session');
    } finally {
      sessionState.sessions = originalSessions;
      sessionUiState.sessionStatusFilter = 'all';
    }
  });

  it('filters the sidebar to sessions with delivery recovery signals', () => {
    const originalSessions = sessionState.sessions;
    sessionUiState.sessionStatusFilter = 'artifact';
    sessionState.sessions = [
      {
        ...originalSessions[0],
        id: 'artifact-session',
        title: 'Artifact Session',
        workbenchSnapshot: {
          summary: 'Workspace output',
          labels: ['工作区'],
          primarySurface: 'workspace',
          recentToolNames: ['Write'],
        },
      },
      {
        ...originalSessions[0],
        id: 'research-session',
        title: 'Research Session',
        workbenchSnapshot: {
          summary: 'Browser research',
          labels: ['Browser'],
          primarySurface: 'browser',
          recentToolNames: ['browser_action'],
        },
      },
    ];

    try {
      const html = renderToStaticMarkup(React.createElement(Sidebar));

      expect(html).toContain('Artifact Session');
      expect(html).toContain('交付线索');
      expect(html).not.toContain('Research Session');
    } finally {
      sessionState.sessions = originalSessions;
      sessionUiState.sessionStatusFilter = 'all';
    }
  });

  it('resolves the runtime logs directory from config scope', () => {
    expect(resolveRuntimeLogsDir({
      workingDirectory: null,
      generatedAt: 1,
      layers: [
        {
          id: 'runtime',
          label: 'Runtime',
          description: '',
          pathLabel: '',
          presentCount: 1,
          activeCount: 1,
          warningCount: 0,
          items: [
            {
              id: 'runtime-app-settings',
              label: '应用 settings',
              description: '',
              path: '/Users/alice/.code-agent/config.json',
              kind: 'file',
              exists: true,
              active: true,
              private: true,
              status: 'active',
            },
          ],
        },
      ],
      writeRecommendations: [],
      safetyScan: {
        status: 'clear',
        scannedAt: 1,
        workingDirectory: null,
        totalFindings: 0,
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
        targets: [],
        findings: [],
      },
    })).toBe('/Users/alice/.code-agent/logs');
  });

  it('opens the runtime logs folder when session diagnostics export fails', async () => {
    domainInvokeMock.mockImplementation(async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SESSION && action === 'exportDiagnostics') {
        return { success: false, error: { message: 'diagnostic build failed' } };
      }
      if (domain === IPC_DOMAINS.WORKSPACE && action === 'getConfigScope') {
        return {
          success: true,
          data: {
            workingDirectory: null,
            generatedAt: 1,
            layers: [
              {
                id: 'runtime',
                label: 'Runtime',
                description: '',
                pathLabel: '',
                presentCount: 1,
                activeCount: 1,
                warningCount: 0,
                items: [
                  {
                    id: 'runtime-app-settings',
                    label: '应用 settings',
                    description: '',
                    path: '/Users/alice/.code-agent/config.json',
                    kind: 'file',
                    exists: true,
                    active: true,
                    private: true,
                    status: 'active',
                  },
                ],
              },
            ],
            writeRecommendations: [],
            safetyScan: {
              status: 'clear',
              scannedAt: 1,
              workingDirectory: null,
              totalFindings: 0,
              criticalCount: 0,
              warningCount: 0,
              infoCount: 0,
              targets: [],
              findings: [],
            },
          },
        };
      }
      if (domain === IPC_DOMAINS.WORKSPACE && action === 'openPath') {
        return { success: true, data: '' };
      }
      return { success: true, data: null };
    });
    renderSidebarWithContextMenu();

    const exportLogsAction = menuState.items.find((item) => item.label === '导出会话日志');
    expect(exportLogsAction).toBeTruthy();

    await exportLogsAction?.onClick();

    expect(domainInvokeMock).toHaveBeenCalledWith(IPC_DOMAINS.SESSION, 'exportDiagnostics', {
      sessionId: 'session-1',
    });
    expect(domainInvokeMock).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'openPath', {
      filePath: '/Users/alice/.code-agent/logs',
    });
    expect(showToastMock).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('已打开日志目录'),
    );
  });

  it('reuses the selected session workbench in the current session from context menu', async () => {
    renderSidebarWithContextMenu();

    const reuseAction = menuState.items.find((item) => item.label === '在当前会话复用工作台');
    expect(reuseAction).toBeTruthy();
    expect(reuseAction?.disabled).not.toBe(true);

    await reuseAction?.onClick();

    expect(domainInvokeMock).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'setCurrent', {
      dir: '/repo/code-agent',
    });
    expect(setWorkingDirectoryMock).toHaveBeenCalledWith('/repo/code-agent');
    expect(applySessionWorkbenchPresetMock).toHaveBeenCalledWith(sessionState.sessions[0]);
  });

  it('saves the selected session workbench as a named preset from context menu', () => {
    promptMock.mockReturnValue('Browser review preset');
    renderSidebarWithContextMenu();

    const savePresetAction = menuState.items.find((item) => item.label === '保存工作台为 Preset');
    expect(savePresetAction).toBeTruthy();
    expect(savePresetAction?.disabled).not.toBe(true);

    savePresetAction?.onClick();

    expect(promptMock).toHaveBeenCalledWith('Preset 名称', 'Reviewable Session');
    expect(saveWorkbenchPresetFromSessionMock).toHaveBeenCalledWith(sessionState.sessions[0], {
      name: 'Browser review preset',
    });
  });

  it('applies a saved local workbench preset from context menu', async () => {
    const preset = {
      version: 1,
      id: 'preset-1',
      name: 'Saved Browser',
      createdAt: 100,
      updatedAt: 100,
      source: { kind: 'manual' },
      context: {
        workingDirectory: '/repo/saved',
        routingMode: 'parallel',
        targetAgentIds: [],
        browserSessionMode: 'managed',
        selectedSkillIds: ['review-skill'],
        selectedConnectorIds: ['mail'],
        selectedMcpServerIds: ['github'],
      },
    };
    workbenchPresetState.presets = [preset];
    domainInvokeMock.mockResolvedValueOnce({ success: true, data: '/repo/saved' });
    renderSidebarWithContextMenu();

    const applyPresetAction = menuState.items.find((item) => item.label === '应用 Preset: Saved Browser');
    expect(applyPresetAction).toBeTruthy();

    await applyPresetAction?.onClick();

    expect(domainInvokeMock).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'setCurrent', {
      dir: '/repo/saved',
    });
    expect(setWorkingDirectoryMock).toHaveBeenCalledWith('/repo/saved');
    expect(applyWorkbenchPresetMock).toHaveBeenCalledWith(preset);
  });

  it('applies a saved local workbench recipe from context menu', async () => {
    const recipe = {
      version: 1,
      id: 'recipe-1',
      name: 'Daily Browser Flow',
      createdAt: 100,
      updatedAt: 100,
      source: { kind: 'manual' },
      steps: [
        {
          id: 'step-1',
          name: 'Browser',
          context: {
            workingDirectory: '/repo/recipe',
            routingMode: 'direct',
            targetAgentIds: ['agent-1'],
            browserSessionMode: 'managed',
            selectedSkillIds: ['review-skill'],
            selectedConnectorIds: [],
            selectedMcpServerIds: [],
          },
        },
        {
          id: 'step-2',
          name: 'Mail',
          context: {
            workingDirectory: null,
            routingMode: 'auto',
            targetAgentIds: [],
            browserSessionMode: 'none',
            selectedSkillIds: ['review-skill'],
            selectedConnectorIds: ['mail'],
            selectedMcpServerIds: ['github'],
          },
        },
      ],
    };
    workbenchPresetState.recipes = [recipe];
    domainInvokeMock.mockResolvedValueOnce({ success: true, data: '/repo/recipe' });
    renderSidebarWithContextMenu();

    const applyRecipeAction = menuState.items.find((item) => item.label === '应用 Recipe: Daily Browser Flow');
    expect(applyRecipeAction).toBeTruthy();

    await applyRecipeAction?.onClick();

    expect(domainInvokeMock).toHaveBeenCalledWith(IPC_DOMAINS.WORKSPACE, 'setCurrent', {
      dir: '/repo/recipe',
    });
    expect(setWorkingDirectoryMock).toHaveBeenCalledWith('/repo/recipe');
    expect(applyWorkbenchRecipeMock).toHaveBeenCalledWith(recipe);
  });

  it('hides workbench reuse and preset actions when the session has no reusable workbench state', () => {
    const originalSession = sessionState.sessions[0];
    sessionState.sessions[0] = {
      ...originalSession,
      workingDirectory: undefined,
      workbenchSnapshot: {
        summary: '纯聊天',
        labels: ['chat'],
        recentToolNames: [],
      },
      workbenchProvenance: undefined,
    };

    renderSidebarWithContextMenu();

    const reuseAction = menuState.items.find((item) => item.label === '在当前会话复用工作台');
    expect(reuseAction).toBeUndefined();
    const savePresetAction = menuState.items.find((item) => item.label === '保存工作台为 Preset');
    expect(savePresetAction).toBeUndefined();

    sessionState.sessions[0] = originalSession;
  });
});

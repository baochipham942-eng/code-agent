import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';

const reactState = vi.hoisted(() => ({
  forcedContextMenuSession: null as any,
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
      if (reactState.forcedContextMenuSession && reactState.useStateCalls === 5) {
        return [
          { x: 24, y: 24, session: reactState.forcedContextMenuSession },
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
  sessionStatusFilter: 'all' as 'all' | 'background',
  setSessionStatusFilter: vi.fn(),
  softDelete: vi.fn(),
  undoDelete: vi.fn(),
  pendingDelete: null,
  expandedWorkspaces: {},
  setWorkspaceExpanded: vi.fn(),
};

const appState = {
  clearPlanningState: vi.fn(),
  setShowSettings: vi.fn(),
  setShowEvalCenter: setShowEvalCenterMock,
  setWorkingDirectory: setWorkingDirectoryMock,
};

const authState = {
  user: null,
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

import { Sidebar } from '../../../src/renderer/components/Sidebar';

function renderSidebarWithContextMenu() {
  reactState.useStateCalls = 0;
  reactState.forcedContextMenuSession = sessionState.sessions[0];
  menuState.items = [];
  renderToStaticMarkup(React.createElement(Sidebar));
  expect(menuState.items.length).toBeGreaterThan(0);
}

describe('Sidebar review actions', () => {
  beforeEach(() => {
    reactState.useStateCalls = 0;
    reactState.forcedContextMenuSession = null;
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
    workbenchPresetState.presets = [];
    workbenchPresetState.recipes = [];
    Reflect.set(globalThis, 'window', {
      domainAPI: {
        invoke: domainInvokeMock,
      },
      prompt: promptMock,
    });
  });

  it('enqueues the selected session into review queue from context menu', async () => {
    renderSidebarWithContextMenu();

    const queueAction = menuState.items.find((item) => item.label === '加入 Review');
    expect(queueAction).toBeTruthy();

    await queueAction?.onClick();

    expect(invokeMock).toHaveBeenCalledWith(IPC_CHANNELS.EVALUATION_REVIEW_QUEUE_ENQUEUE, {
      sessionId: 'session-1',
      sessionTitle: 'Reviewable Session',
      reason: 'manual_review',
      source: 'session_list',
    });
  });

  it('opens eval center on the selected session replay from context menu', () => {
    renderSidebarWithContextMenu();

    const replayAction = menuState.items.find((item) => item.label === '打开 Replay');
    expect(replayAction).toBeTruthy();

    replayAction?.onClick();

    expect(setShowEvalCenterMock).toHaveBeenCalledWith(true, undefined, 'session-1');
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

    const savePresetAction = menuState.items.find((item) => item.label === '保存为 Preset');
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

  it('disables workbench reuse when the session has no reusable workbench state', () => {
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
    expect(reuseAction).toBeTruthy();
    expect(reuseAction?.disabled).toBe(true);
    const savePresetAction = menuState.items.find((item) => item.label === '保存为 Preset');
    expect(savePresetAction).toBeTruthy();
    expect(savePresetAction?.disabled).toBe(true);

    sessionState.sessions[0] = originalSession;
  });
});

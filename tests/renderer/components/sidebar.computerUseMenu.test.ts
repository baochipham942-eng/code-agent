 
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const reactState = vi.hoisted(() => ({
  useStateCalls: 0,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (initial: unknown) => {
      reactState.useStateCalls += 1;
      if (reactState.useStateCalls === 3) {
        return [true, vi.fn()] as const;
      }
      return actual.useState(initial);
    },
  };
});

const sessionState = {
  sessions: [] as any[],
  currentSessionId: null as string | null,
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
  searchQuery: '',
  setSearchQuery: vi.fn(),
  sessionStatusFilter: 'all',
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
  setShowPromptManager: vi.fn(),
  setShowEvalCenter: vi.fn(),
  setWorkingDirectory: vi.fn(),
  setShowLab: vi.fn(),
  showCronCenter: false,
  setShowCronCenter: vi.fn(),
  showTimeCapabilityCenter: false,
  setShowTimeCapabilityCenter: vi.fn(),
  showDesktopPanel: false,
  setShowDesktopPanel: vi.fn(),
  showComputerUsePanel: false,
  setShowComputerUsePanel: vi.fn(),
  showActivityPanel: false,
  setShowActivityPanel: vi.fn(),
  showKnowledgeMemoryPanel: false,
  setShowKnowledgeMemoryPanel: vi.fn(),
  showDAGPanel: false,
  setShowDAGPanel: vi.fn(),
};

const authState = {
  user: {
    nickname: 'Dad',
    email: 'dad@example.com',
    avatarUrl: null,
  },
  isAuthenticated: true,
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

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector?: (state: typeof authState) => unknown) => selector ? selector(authState) : authState,
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: { sessionStates: Record<string, unknown> }) => unknown) =>
    selector ? selector({ sessionStates: {} }) : { sessionStates: {} },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
    on: vi.fn(),
  },
}));

import { Sidebar } from '../../../src/renderer/components/Sidebar';

describe('Sidebar Computer Use menu entry', () => {
  beforeEach(() => {
    reactState.useStateCalls = 0;
  });

  it('renders Computer Use in the expanded lower-left user menu', () => {
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('用户菜单');
    expect(html).toContain('桌面采集');
    expect(html).toContain('Computer Use');
  });
});

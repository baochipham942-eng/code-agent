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
  sessionStatusFilter: 'all' as 'all' | 'background',
  setSessionStatusFilter: vi.fn(),
  softDelete: vi.fn(),
  undoDelete: vi.fn(),
  pendingDelete: null,
};

const appState = {
  clearPlanningState: vi.fn(),
  setShowSettings: vi.fn(),
  setShowEvalCenter: vi.fn(),
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

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector?: (state: typeof authState) => unknown) => selector ? selector(authState) : authState,
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: { sessionStates: Record<string, unknown> }) => unknown) =>
    selector ? selector({ sessionStates: { 'session-1': { status: 'running' } } }) : { sessionStates: { 'session-1': { status: 'running' } } },
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
    sessionUiState.searchQuery = '';
    sessionUiState.sessionStatusFilter = 'all';
  });

  it('renders session-native status, turn count, and workbench snapshot', () => {
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('Session Native Workspace');
    expect(html).toContain('后台');
    expect(html).toContain('3 轮');
    expect(html).toContain('工作区 · Browser');
    expect(html).toContain('gpt-5.4');
  });

  it('supports the background-only quick filter', () => {
    sessionUiState.sessionStatusFilter = 'background';

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('后台中');
    expect(html).toContain('Session Native Workspace');
    expect(html).not.toContain('Finished Session');
  });
});

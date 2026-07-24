import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const sessionState = {
  sessions: [] as any[],
  currentSessionId: null as string | null,
  messages: [] as any[],
  todos: [] as any[],
  isLoading: true,
  createSession: vi.fn(async () => null),
  switchSession: vi.fn(async () => {}),
  archiveSession: vi.fn(async () => {}),
  unarchiveSession: vi.fn(async () => {}),
  unreadSessionIds: new Set<string>(),
  sessionRuntimes: new Map(),
  backgroundSessions: [] as any[],
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
	  sessionStatusFilter: 'all',
	  setSessionStatusFilter: vi.fn(),
  trajectoryTierFilter: 'all',
  setTrajectoryTierFilter: vi.fn(),
  trajectoryFailureFilter: 'all',
  setTrajectoryFailureFilter: vi.fn(),
  trajectoryReviewFilter: 'all',
  setTrajectoryReviewFilter: vi.fn(),
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
  setShowEvalCenter: vi.fn(),
  showProjectCollaborationPage: false,
  openProjectCollaborationPage: vi.fn(),
  optionalUpdateInfo: null as any,
  setShowOptionalUpdateModal: vi.fn(),
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
    selector ? selector({ sessionStates: {} }) : { sessionStates: {} },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
    on: vi.fn(),
  },
}));

import { Sidebar } from '../../../src/renderer/components/Sidebar';

describe('Sidebar new session button', () => {
  beforeEach(() => {
    appState.optionalUpdateInfo = null;
    appState.setShowOptionalUpdateModal.mockReset();
    appState.showProjectCollaborationPage = false;
    appState.openProjectCollaborationPage.mockReset();
    authState.user = null;
    authState.isAuthenticated = false;
  });

  it('does not switch into the loading spinner just because the session list is loading', () => {
    const html = renderToStaticMarkup(React.createElement(Sidebar));
    const newTaskButtonHtml = html.match(/<button[^>]*data-testid="sidebar-new-task"[^>]*>.*?<\/button>/)?.[0] ?? '';

    expect(html).toContain('data-testid="neo-brand-mark"');
    expect(html).toContain('新任务');
    // 新任务默认纯对话不继承上下文；独立「空白」入口已下线。
    expect(html).toContain('新建任务（纯对话，不继承项目上下文）');
    expect(html).toContain('开始一段新的协作');
    expect(html).not.toContain('新建空白会话，不继承项目上下文');
    expect(newTaskButtonHtml).toContain('lucide-plus');
    expect(newTaskButtonHtml).not.toContain('lucide-loader-circle');
    expect(html).toContain('data-testid="sidebar-search-trigger"');
  });

  it('shows a persistent update entry at the lower sidebar for optional app updates', () => {
    appState.optionalUpdateInfo = {
      hasUpdate: true,
      forceUpdate: false,
      currentVersion: '0.16.88',
      latestVersion: '0.16.89',
      releaseNotes: 'Small fixes',
    };

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('更新可用');
    expect(html).toContain('v0.16.89');
    expect(html).toContain('查看 Agent Neo v0.16.89 更新内容');
  });

  it('wires the lower account menu to the project collaboration page', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/components/Sidebar.tsx'), 'utf8');

    expect(source).toContain('openProjectCollaborationPage(currentSessionProjectId)');
    expect(source).toContain('label={sb.menuNeoCollab}');
  });
});

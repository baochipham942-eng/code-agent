 
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
  showLab: false,
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
    id: 'user-admin',
    nickname: 'Dad',
    email: 'dad@example.com',
    avatarUrl: null,
    isAdmin: true,
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

import { Sidebar, isAccountMenuEventOutside } from '../../../src/renderer/components/Sidebar';

describe('Sidebar account menu entry planning', () => {
  beforeEach(() => {
    reactState.useStateCalls = 0;
    appState.showComputerUsePanel = false;
    appState.showInAppValidationPanel = false;
    authState.user.isAdmin = true;
  });

  it('keeps common entries visible and groups advanced tools behind one disclosure', () => {
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('用户菜单');
    expect(html).toContain('管理员');
    expect(html).toContain('常用');
    expect(html).toContain('Activity');
    expect(html).toContain('知识与记忆');
    expect(html).toContain('评测中心');
    expect(html).toContain('自动化');
    expect(html).toContain('提示词');
    expect(html).toContain('管理与诊断');
    expect(html).toContain('Telemetry 调试');
    expect(html).toContain('内部评测');
    expect(html).toContain('高级工具');
    expect(html).not.toContain('桌面采集');
    expect(html).not.toContain('Computer Use');
  });

  it('shows internal validation tools only for admin users', () => {
    appState.showComputerUsePanel = true;
    const adminHtml = renderToStaticMarkup(React.createElement(Sidebar));

    expect(adminHtml).toContain('Computer Use');
    expect(adminHtml).toContain('In-App 验证');
    expect(adminHtml).toContain('诊断');
    expect(adminHtml).toContain('验证');

    reactState.useStateCalls = 0;
    authState.user.isAdmin = false;
    const memberHtml = renderToStaticMarkup(React.createElement(Sidebar));

    expect(memberHtml).not.toContain('Computer Use');
    expect(memberHtml).not.toContain('In-App 验证');
  });

  it('detects outside targets for account menu dismissal', () => {
    const inside = {} as Node;
    const outside = {} as Node;
    const menu = {
      contains: vi.fn((node: Node) => node === inside),
    };

    expect(isAccountMenuEventOutside(menu, inside)).toBe(false);
    expect(isAccountMenuEventOutside(menu, outside)).toBe(true);
    expect(isAccountMenuEventOutside(null, outside)).toBe(false);
  });
});

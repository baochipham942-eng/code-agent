import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const appState = {
  workingDirectory: '/repo/other',
  setWorkingDirectory: vi.fn(),
  setShowEvalCenter: vi.fn(),
  openDevServerLauncher: vi.fn(),
  language: 'zh' as const,
  setLanguage: vi.fn(),
  cloudUIStrings: undefined,
};

const sessionState = {
  currentSessionId: 'session-1',
  sessions: [
    {
      id: 'session-1',
      title: '修 Phase 5',
      workingDirectory: '/repo/code-agent',
      messageCount: 4,
      turnCount: 2,
    },
  ] as any[],
  sessionRuntimes: new Map<string, any>([
    ['session-1', { sessionId: 'session-1', status: 'paused', activeAgentCount: 0, lastActivityAt: Date.now() }],
  ]),
  backgroundSessions: [] as any[],
  moveToBackground: vi.fn(async () => true),
};

const taskState = {
  sessionStates: {
    'session-1': { status: 'idle' },
  } as Record<string, any>,
};

const workflowState = {
  runs: {} as Record<string, any>,
};

const backgroundTaskState = {
  tasks: [] as any[],
};

const authState = {
  user: null as { isAdmin?: boolean } | null,
};

const uiState = {
  showToast: vi.fn(),
};

const evalState = {
  reviewQueue: [] as Array<{ sessionId: string }>,
  enqueueReviewItem: vi.fn(async () => ({})),
};

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
    { getState: () => appState },
  ),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: typeof sessionState) => unknown) => selector ? selector(sessionState) : sessionState,
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: typeof taskState) => unknown) => selector ? selector(taskState) : taskState,
}));

vi.mock('../../../src/renderer/stores/workflowStore', () => ({
  useWorkflowStore: (selector?: (state: typeof workflowState) => unknown) => selector ? selector(workflowState) : workflowState,
}));

vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector?: (state: typeof backgroundTaskState) => unknown) => selector ? selector(backgroundTaskState) : backgroundTaskState,
}));

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector?: (state: typeof authState) => unknown) => selector ? selector(authState) : authState,
}));

vi.mock('../../../src/renderer/stores/uiStore', () => ({
  useUIStore: (selector?: (state: typeof uiState) => unknown) => selector ? selector(uiState) : uiState,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/stores/evalCenterStore', () => ({
  useEvalCenterStore: (selector?: (state: typeof evalState) => unknown) => selector ? selector(evalState) : evalState,
}));

import { SessionActionsMenu } from '../../../src/renderer/components/SessionActionsMenu';

describe('SessionActionsMenu', () => {
  beforeEach(() => {
    uiState.showToast.mockReset();
    authState.user = null;
    sessionState.currentSessionId = 'session-1';
    sessionState.sessions = [
      {
        id: 'session-1',
        title: '修 Phase 5',
        workingDirectory: '/repo/code-agent',
        messageCount: 4,
        turnCount: 2,
      },
    ];
    workflowState.runs = {};
    backgroundTaskState.tasks = [];
  });

  it('renders the current-session action trigger when a session is active', () => {
    const html = renderToStaticMarkup(React.createElement(SessionActionsMenu));

    expect(html).toContain('会话动作');
  });

  it('does not render when there is no current session', () => {
    sessionState.currentSessionId = null as unknown as string;
    sessionState.sessions = [];

    const html = renderToStaticMarkup(React.createElement(SessionActionsMenu));

    expect(html).not.toContain('会话动作');
  });
});

// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const appState = {
  workingDirectory: '/repo/other',
  setWorkingDirectory: vi.fn(),
  setShowEvalCenter: vi.fn(),
  openDevServerLauncher: vi.fn(),
  openWorkbenchTab: vi.fn(),
  pendingPermissionRequest: null as any,
  pendingPermissionSessionId: null as string | null,
  queuedPermissionRequests: {} as Record<string, any[]>,
  language: 'zh' as const,
  setLanguage: vi.fn(),
  cloudUIStrings: undefined,
};

const sessionState = {
  currentSessionId: 'session-1',
  sessions: [] as any[],
  sessionRuntimes: new Map<string, any>(),
  backgroundTasks: [] as any[],
  pendingUserQuestionsBySessionId: new Map<string, any[]>(),
  moveToBackground: vi.fn(async () => true),
};

const taskState = {
  sessionStates: {} as Record<string, any>,
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

describe('SessionActionsMenu session-state rendering', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = null;
    sessionState.currentSessionId = 'session-1';
    sessionState.sessions = [
      {
        id: 'session-1',
        title: '继续推进 Phase 5',
        workingDirectory: '/repo/code-agent',
        messageCount: 6,
        turnCount: 2,
      },
    ];
    sessionState.sessionRuntimes = new Map([
      ['session-1', { sessionId: 'session-1', status: 'paused', activeAgentCount: 0, contextHealth: null, lastActivityAt: Date.now() - 3_000 }],
    ]);
    sessionState.backgroundTasks = [];
    sessionState.pendingUserQuestionsBySessionId = new Map();
    taskState.sessionStates = {
      'session-1': { status: 'idle' },
    };
    workflowState.runs = {};
    backgroundTaskState.tasks = [];
    evalState.reviewQueue = [];
  });

  it('renders a stable current-session action trigger for paused sessions', () => {
    const html = renderToStaticMarkup(React.createElement(SessionActionsMenu));

    expect(html).toContain('会话动作');
  });

  it('renders a stable current-session action trigger for live sessions', () => {
    sessionState.sessionRuntimes = new Map([
      ['session-1', { sessionId: 'session-1', status: 'running', activeAgentCount: 1, contextHealth: null, lastActivityAt: Date.now() - 1_000 }],
    ]);
    taskState.sessionStates = {
      'session-1': { status: 'running' },
    };

    const html = renderToStaticMarkup(React.createElement(SessionActionsMenu));

    expect(html).toContain('会话动作');
  });

  it('keeps Move to Background visible for ordinary running sessions', () => {
    sessionState.sessionRuntimes = new Map([
      ['session-1', { sessionId: 'session-1', status: 'running', activeAgentCount: 1, contextHealth: null, lastActivityAt: Date.now() - 1_000 }],
    ]);
    taskState.sessionStates = {
      'session-1': { status: 'running' },
    };

    render(React.createElement(SessionActionsMenu));
    fireEvent.click(screen.getByLabelText('会话动作'));

    expect(screen.getByText('移到后台')).toBeTruthy();
  });

  it('does not show Move to Background for durable waiting-input sessions', () => {
    sessionState.sessions = [
      {
        id: 'session-1',
        title: '等待用户输入',
        workingDirectory: '/repo/code-agent',
        messageCount: 6,
        turnCount: 2,
        status: 'running',
        durableWaitingInput: true,
      },
    ];
    sessionState.sessionRuntimes = new Map([
      ['session-1', { sessionId: 'session-1', status: 'running', activeAgentCount: 1, contextHealth: null, lastActivityAt: Date.now() - 1_000 }],
    ]);
    taskState.sessionStates = {
      'session-1': { status: 'running' },
    };

    render(React.createElement(SessionActionsMenu));
    fireEvent.click(screen.getByLabelText('会话动作'));

    expect(screen.queryByText('移到后台')).toBeNull();
  });

  it('does not show Move to Background for pending user-question sessions', () => {
    sessionState.sessionRuntimes = new Map([
      ['session-1', { sessionId: 'session-1', status: 'running', activeAgentCount: 1, contextHealth: null, lastActivityAt: Date.now() - 1_000 }],
    ]);
    taskState.sessionStates = {
      'session-1': { status: 'running' },
    };
    sessionState.pendingUserQuestionsBySessionId = new Map([
      ['session-1', [{ id: 'q-1', sessionId: 'session-1', questions: [], timestamp: Date.now() }]],
    ]);

    render(React.createElement(SessionActionsMenu));
    fireEvent.click(screen.getByLabelText('会话动作'));

    expect(screen.queryByText('移到后台')).toBeNull();
  });
});

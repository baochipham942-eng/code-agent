import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const appState = {
  workingDirectory: '/repo/other',
  setWorkingDirectory: vi.fn(),
  setShowEvalCenter: vi.fn(),
  openDevServerLauncher: vi.fn(),
};

const sessionState = {
  currentSessionId: 'session-1',
  sessions: [] as any[],
  sessionRuntimes: new Map<string, any>(),
  backgroundTasks: [] as any[],
  moveToBackground: vi.fn(async () => true),
};

const taskState = {
  sessionStates: {} as Record<string, any>,
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

vi.mock('../../../src/renderer/stores/evalCenterStore', () => ({
  useEvalCenterStore: (selector?: (state: typeof evalState) => unknown) => selector ? selector(evalState) : evalState,
}));

import { SessionActionsMenu } from '../../../src/renderer/components/SessionActionsMenu';

describe('SessionActionsMenu session-state rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    taskState.sessionStates = {
      'session-1': { status: 'idle' },
    };
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
});

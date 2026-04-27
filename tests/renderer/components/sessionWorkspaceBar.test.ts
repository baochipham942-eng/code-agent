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
  backgroundTasks: [] as any[],
  moveToBackground: vi.fn(async () => true),
};

const taskState = {
  sessionStates: {
    'session-1': { status: 'idle' },
  } as Record<string, any>,
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

describe('SessionActionsMenu', () => {
  beforeEach(() => {
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

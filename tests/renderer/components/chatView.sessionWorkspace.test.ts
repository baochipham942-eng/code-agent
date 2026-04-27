import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const sessionState = {
  currentSessionId: 'session-1',
  hasOlderMessages: false,
  isLoadingOlder: false,
  loadOlderMessages: vi.fn(async () => {}),
  sessions: [
    {
      id: 'session-1',
      title: '继续推进 Phase 5',
      modelConfig: { provider: 'openai', model: 'gpt-5.4' },
      createdAt: Date.now() - 20_000,
      updatedAt: Date.now() - 5_000,
      workingDirectory: '/repo/code-agent',
      messageCount: 6,
      turnCount: 2,
      workbenchSnapshot: {
        summary: '工作区 · Browser',
        labels: ['工作区', 'Browser'],
        recentToolNames: ['browser_action'],
      },
    },
  ] as any[],
  sessionRuntimes: new Map([
    ['session-1', { sessionId: 'session-1', status: 'paused', activeAgentCount: 0, contextHealth: null, lastActivityAt: Date.now() - 3_000 }],
  ]),
  backgroundTasks: [],
  moveToBackground: vi.fn(async () => true),
};

const appState = {
  showPreviewPanel: false,
  workingDirectory: '/repo/other',
  setShowSettings: vi.fn(),
};

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
    {
      getState: () => ({
        setWorkingDirectory: vi.fn(),
      }),
    },
  ),
}));

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: (selector?: (state: { buildContext: () => object; hydrateFromSession: (...args: unknown[]) => void }) => unknown) => selector
    ? selector({
      buildContext: () => ({}),
      hydrateFromSession: vi.fn(),
    })
    : {
      buildContext: () => ({}),
      hydrateFromSession: vi.fn(),
    },
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: typeof sessionState) => unknown) => selector ? selector(sessionState) : sessionState,
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: { sessionStates: Record<string, unknown> }) => unknown) =>
    selector ? selector({ sessionStates: { 'session-1': { status: 'idle' } } }) : { sessionStates: { 'session-1': { status: 'idle' } } },
}));

vi.mock('../../../src/renderer/stores/modeStore', () => ({
  useModeStore: (selector?: (state: { isPaused: boolean; setIsPaused: (...args: unknown[]) => void }) => unknown) => selector
    ? selector({ isPaused: false, setIsPaused: vi.fn() })
    : { isPaused: false, setIsPaused: vi.fn() },
}));

vi.mock('../../../src/renderer/stores/swarmStore', () => ({
  useSwarmStore: (selector?: (state: { launchRequests: unknown[] }) => unknown) =>
    selector ? selector({ launchRequests: [] }) : { launchRequests: [] },
}));

vi.mock('../../../src/renderer/stores/localBridgeStore', () => ({
  useLocalBridgeStore: () => ({
    status: 'connected',
    version: '0.1.0',
    workingDirectory: '/repo/other',
  }),
}));

vi.mock('../../../src/renderer/stores/messageActionStore', () => ({
  useMessageActionStore: (selector?: (state: { register: (...args: unknown[]) => void; unregister: () => void }) => unknown) => selector
    ? selector({ register: vi.fn(), unregister: vi.fn() })
    : { register: vi.fn(), unregister: vi.fn() },
}));

vi.mock('../../../src/renderer/hooks/useAgent', () => ({
  useAgent: () => ({
    messages: [],
    isProcessing: false,
    sendMessage: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    researchDetected: null,
    dismissResearchDetected: vi.fn(),
    isInterrupting: false,
  }),
}));

vi.mock('../../../src/renderer/hooks/useRequireAuth', () => ({
  useRequireAuth: () => ({
    requireAuthAsync: async (fn: () => unknown) => fn(),
  }),
}));

vi.mock('../../../src/renderer/hooks/useTurnProjection', () => ({
  useTurnProjection: () => ({ turns: [] }),
}));

vi.mock('../../../src/renderer/hooks/useTurnExecutionClarity', () => ({
  useTurnExecutionClarity: (projection: unknown) => projection,
}));

vi.mock('../../../src/renderer/components/features/chat/TurnBasedTraceView', () => ({
  TurnBasedTraceView: () => React.createElement('div', null, 'trace-view'),
}));

vi.mock('../../../src/renderer/components/features/chat/ChatInput', () => ({
  ChatInput: React.forwardRef((_props, _ref) => React.createElement('div', null, 'chat-input')),
}));

vi.mock('../../../src/renderer/components/features/chat/ChatInput/useFileUpload', () => ({
  useFileUpload: () => ({
    processFile: vi.fn(async () => null),
    processFolderEntry: vi.fn(async () => null),
  }),
}));

vi.mock('../../../src/renderer/components/features/chat/TaskStatusBar', () => ({
  TaskStatusBar: () => React.createElement('div', null, 'task-status-bar'),
}));

vi.mock('../../../src/renderer/components/features/chat/LocalBridgePrompt', () => ({
  LocalBridgePrompt: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/BridgeUpdatePrompt', () => ({
  BridgeUpdatePrompt: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/DirectoryPickerModal', () => ({
  DirectoryPickerModal: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/ChatSearchBar', () => ({
  ChatSearchBar: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/InlineStrip', () => ({
  InlineStrip: () => null,
}));

vi.mock('../../../src/renderer/components/PreviewPanel', () => ({
  PreviewPanel: () => null,
}));

vi.mock('../../../src/renderer/components/features/chat/SemanticResearchIndicator', () => ({
  SemanticResearchIndicator: () => null,
}));

vi.mock('../../../src/renderer/components/RewindPanel', () => ({
  RewindPanel: () => null,
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
}));

import { ChatView } from '../../../src/renderer/components/ChatView';

describe('ChatView session shell', () => {
  it('keeps session actions out of the chat body', () => {
    const html = renderToStaticMarkup(React.createElement(ChatView));

    expect(html).toContain('task-status-bar');
    expect(html).toContain('chat-input');
    expect(html).not.toContain('继续推进 Phase 5');
  });
});

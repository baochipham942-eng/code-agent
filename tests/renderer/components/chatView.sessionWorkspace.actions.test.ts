import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { IPC_DOMAINS } from '@shared/ipc';

const moveToBackgroundMock = vi.fn(async () => true);
const setWorkingDirectoryMock = vi.fn();
const setShowEvalCenterMock = vi.fn();
const domainInvokeMock = vi.fn();
const createObjectURLMock = vi.fn(() => 'blob:session-markdown');
const revokeObjectURLMock = vi.fn();
const anchorClickMock = vi.fn();
const loadReviewQueueMock = vi.fn(async () => {});
const enqueueReviewItemMock = vi.fn(async () => ({
  id: 'review:session:session-1',
  trace: {
    traceId: 'session:session-1',
    source: 'session_replay',
    sessionId: 'session-1',
    replayKey: 'session-1',
  },
  sessionId: 'session-1',
  sessionTitle: '继续推进 Phase 5',
  reason: 'manual_review',
  source: 'current_session_bar',
  createdAt: 100,
  updatedAt: 100,
}));

const anchorElement = {
  href: '',
  download: '',
  click: anchorClickMock,
};

const sessionState = {
  currentSessionId: 'session-1',
  hasOlderMessages: false,
  isLoadingOlder: false,
  loadOlderMessages: vi.fn(async () => {}),
  sessions: [] as any[],
  sessionRuntimes: new Map<string, any>(),
  backgroundTasks: [] as any[],
  moveToBackground: moveToBackgroundMock,
};

const taskStoreState = {
  sessionStates: {
    'session-1': { status: 'idle' },
  } as Record<string, any>,
};

const appState = {
  showPreviewPanel: false,
  workingDirectory: '/repo/other',
  setShowSettings: vi.fn(),
  setShowEvalCenter: setShowEvalCenterMock,
};

interface CapturedWorkspaceBarProps {
  title: string;
  canResume?: boolean;
  canMoveToBackground?: boolean;
  isInReviewQueue?: boolean;
  workingDirectory?: string | null;
  currentWorkingDirectory?: string | null;
  onResume?: () => Promise<void> | void;
  onMoveToBackground?: () => Promise<void> | void;
  onAddToReviewQueue?: () => Promise<void> | void;
  onOpenReplay?: () => Promise<void> | void;
  onExportMarkdown?: () => Promise<void> | void;
  onReopenWorkspace?: () => Promise<void> | void;
}

let capturedWorkspaceBarProps: CapturedWorkspaceBarProps | null = null;

function createSession(overrides: Partial<any> = {}) {
  return {
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
    ...overrides,
  };
}

function renderChatView() {
  capturedWorkspaceBarProps = null;
  renderToStaticMarkup(React.createElement(ChatView));
  expect(capturedWorkspaceBarProps).toBeTruthy();
  return capturedWorkspaceBarProps as CapturedWorkspaceBarProps;
}

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: Object.assign(
    (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
    {
      getState: () => ({
        setWorkingDirectory: setWorkingDirectoryMock,
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
  useTaskStore: (selector?: (state: typeof taskStoreState) => unknown) =>
    selector ? selector(taskStoreState) : taskStoreState,
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

vi.mock('../../../src/renderer/stores/evalCenterStore', () => ({
  useEvalCenterStore: (selector?: (state: {
    reviewQueue: Array<{ sessionId: string }>;
    loadReviewQueue: () => Promise<void>;
    enqueueReviewItem: typeof enqueueReviewItemMock;
  }) => unknown) => {
    const state = {
      reviewQueue: [] as Array<{ sessionId: string }>,
      loadReviewQueue: loadReviewQueueMock,
      enqueueReviewItem: enqueueReviewItemMock,
    };
    return selector ? selector(state) : state;
  },
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

vi.mock('../../../src/renderer/components/features/chat/SessionWorkspaceBar', () => ({
  SessionWorkspaceBar: (props: CapturedWorkspaceBarProps) => {
    capturedWorkspaceBarProps = props;
    return React.createElement('mock-session-workspace-bar');
  },
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

describe('ChatView session workspace actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWorkspaceBarProps = null;

    sessionState.currentSessionId = 'session-1';
    sessionState.sessions = [createSession()];
    sessionState.sessionRuntimes = new Map([
      ['session-1', { sessionId: 'session-1', status: 'paused', activeAgentCount: 0, contextHealth: null, lastActivityAt: Date.now() - 3_000 }],
    ]);
    sessionState.backgroundTasks = [];
    sessionState.moveToBackground = moveToBackgroundMock;

    taskStoreState.sessionStates = {
      'session-1': { status: 'idle' },
    };

    appState.workingDirectory = '/repo/other';

    Object.assign(globalThis as Record<string, unknown>, {
      window: {
        domainAPI: {
          invoke: domainInvokeMock,
        },
      },
      document: {
        createElement: vi.fn(() => anchorElement),
      },
      URL: {
        createObjectURL: createObjectURLMock,
        revokeObjectURL: revokeObjectURLMock,
      },
    });

    anchorElement.href = '';
    anchorElement.download = '';
  });

  it('wires resume, export markdown, and reopen workspace from the current session bar', async () => {
    domainInvokeMock
      .mockResolvedValueOnce({ success: true, data: null })
      .mockResolvedValueOnce({
        success: true,
        data: {
          markdown: '# Phase 5',
          suggestedFileName: 'phase-5.md',
        },
      })
      .mockResolvedValueOnce({ success: true, data: '/repo/restored' });

    const workspaceBar = renderChatView();

    expect(workspaceBar.canResume).toBe(true);
    expect(workspaceBar.canMoveToBackground).toBe(false);
    expect(workspaceBar.workingDirectory).toBe('/repo/code-agent');
    expect(workspaceBar.currentWorkingDirectory).toBe('/repo/other');

    await workspaceBar.onResume?.();
    await workspaceBar.onExportMarkdown?.();
    await workspaceBar.onReopenWorkspace?.();

    expect(domainInvokeMock).toHaveBeenNthCalledWith(1, IPC_DOMAINS.AGENT, 'resume', { sessionId: 'session-1' });
    expect(domainInvokeMock).toHaveBeenNthCalledWith(2, IPC_DOMAINS.SESSION, 'exportMarkdown', { sessionId: 'session-1' });
    expect(domainInvokeMock).toHaveBeenNthCalledWith(3, IPC_DOMAINS.WORKSPACE, 'setCurrent', { dir: '/repo/code-agent' });

    expect(createObjectURLMock).toHaveBeenCalledTimes(1);
    expect(anchorElement.href).toBe('blob:session-markdown');
    expect(anchorElement.download).toBe('phase-5.md');
    expect(anchorClickMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:session-markdown');
    expect(setWorkingDirectoryMock).toHaveBeenCalledWith('/repo/restored');
  });

  it('wires review queue enqueue and replay opening from the current session bar', async () => {
    const workspaceBar = renderChatView();

    expect(workspaceBar.isInReviewQueue).toBe(false);

    await workspaceBar.onAddToReviewQueue?.();
    await workspaceBar.onOpenReplay?.();

    expect(enqueueReviewItemMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      sessionTitle: '继续推进 Phase 5',
      reason: 'manual_review',
      source: 'current_session_bar',
    });
    expect(setShowEvalCenterMock).toHaveBeenCalledWith(true, undefined, 'session-1');
  });

  it('wires move-to-background when the current session is live', async () => {
    sessionState.sessionRuntimes = new Map([
      ['session-1', { sessionId: 'session-1', status: 'running', activeAgentCount: 1, contextHealth: null, lastActivityAt: Date.now() - 1_000 }],
    ]);
    taskStoreState.sessionStates = {
      'session-1': { status: 'running' },
    };

    const workspaceBar = renderChatView();

    expect(workspaceBar.canResume).toBe(false);
    expect(workspaceBar.canMoveToBackground).toBe(true);

    await workspaceBar.onMoveToBackground?.();

    expect(moveToBackgroundMock).toHaveBeenCalledWith('session-1');
    expect(domainInvokeMock).not.toHaveBeenCalled();
  });
});

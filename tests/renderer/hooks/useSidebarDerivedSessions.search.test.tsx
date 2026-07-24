// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

const state = vi.hoisted(() => ({
  session: {
    sessions: [] as any[],
    currentSessionId: 'message-hit',
    sessionRuntimes: new Map<string, unknown>(),
    backgroundSessions: [] as any[],
    pendingUserQuestionsBySessionId: new Map<string, unknown>(),
  },
  ui: {
    searchQuery: 'needle',
    sessionStatusFilter: 'all' as const,
    trajectoryTierFilter: 'all' as const,
    trajectoryFailureFilter: 'all' as const,
    trajectoryReviewFilter: 'all' as const,
  },
  app: {
    pendingPermissionRequest: null as unknown,
    pendingPermissionSessionId: null as string | null,
    queuedPermissionRequests: [] as unknown[],
  },
  backgroundTask: { tasks: [] as unknown[] },
  workflow: { runs: [] as unknown[] },
  task: { sessionStates: {} as Record<string, { status: string }> },
}));

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

const projectClient = vi.hoisted(() => ({
  getProjectDetail: vi.fn(async (projectId: string) => ({
    project: { id: projectId, name: 'Project', status: 'active', description: '', updatedAt: 1 },
    goals: [],
    roles: [],
    sessionIds: ['message-hit', 'metadata-hit', 'archived-hit'],
  })),
  getProjectArtifacts: vi.fn(async () => []),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (store: unknown) => unknown) => selector(state.session),
}));
vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: (selector: (store: unknown) => unknown) => selector(state.ui),
}));
vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (store: unknown) => unknown) => selector(state.app),
}));
vi.mock('../../../src/renderer/stores/backgroundTaskStore', () => ({
  useBackgroundTaskStore: (selector: (store: unknown) => unknown) => selector(state.backgroundTask),
}));
vi.mock('../../../src/renderer/stores/workflowStore', () => ({
  useWorkflowStore: (selector: (store: unknown) => unknown) => selector(state.workflow),
}));
vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector: (store: unknown) => unknown) => selector(state.task),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: ipc,
}));
vi.mock('../../../src/renderer/services/projectClient', () => projectClient);
vi.mock('../../../src/renderer/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

import { useSidebarDerivedSessions } from '../../../src/renderer/components/features/sidebar/useSidebarDerivedSessions';
import { SidebarSearchDialog } from '../../../src/renderer/components/features/sidebar/SidebarSearchDialog';

beforeEach(() => {
  vi.clearAllMocks();
  state.session.sessions = [
    {
      id: 'message-hit',
      title: 'Unrelated title',
      projectId: 'project-1',
      workingDirectory: '/repo',
      status: 'active',
      messageCount: 2,
      turnCount: 1,
      createdAt: 100,
      updatedAt: 300,
    },
    {
      id: 'metadata-hit',
      title: 'Needle metadata',
      projectId: 'project-1',
      workingDirectory: '/repo',
      status: 'active',
      messageCount: 1,
      turnCount: 1,
      createdAt: 90,
      updatedAt: 200,
    },
    {
      id: 'archived-hit',
      title: 'Needle archived session',
      projectId: 'project-1',
      workingDirectory: '/repo',
      status: 'archived',
      messageCount: 5,
      turnCount: 3,
      createdAt: 80,
      updatedAt: 400,
    },
  ];
  ipc.invoke.mockImplementation(async (channel: string) => {
    if (channel === IPC_CHANNELS.SESSION_SEARCH) {
      return {
        query: 'needle',
        totalMatches: 2,
        sessionsWithMatches: 2,
        searchTime: 1,
        truncated: false,
        results: [
          {
            sessionId: 'message-hit',
            sessionTitle: 'Unrelated title',
            messageId: 'message-1',
            messageIndex: 0,
            turnNumber: 1,
            role: 'user',
            timestamp: 290,
            matchOffset: 4,
            relevance: 0.9,
            snippet: 'body **needle** match',
            matchCount: 1,
          },
          {
            sessionId: 'archived-hit',
            sessionTitle: 'Needle archived session',
            messageId: 'message-archived',
            messageIndex: 0,
            role: 'assistant',
            timestamp: 390,
            relevance: 0.8,
            snippet: 'archived **needle**',
            matchCount: 1,
          },
        ],
      };
    }
    return {};
  });
});

describe('useSidebarDerivedSessions search results', () => {
  it('excludes archived sessions and keeps sessions found only through message content', async () => {
    const SearchHarness = () => {
      const derived = useSidebarDerivedSessions({ canOpenSessionReplay: false });
      return (
        <SidebarSearchDialog
          isOpen
          query={state.ui.searchQuery}
          onQueryChange={vi.fn()}
          onClose={vi.fn()}
          sessions={derived.searchResultSessions}
          currentSessionId={state.session.currentSessionId}
          messageSearchHitsBySessionId={derived.messageSearchHitsBySessionId}
          messageSearchLoading={derived.messageSearchLoading}
          effectiveSearchScope={derived.effectiveSearchScope}
          setSearchScope={derived.setSearchScope}
          canSearchCurrentProject
          onSelectSession={vi.fn()}
        />
      );
    };
    render(<SearchHarness />);

    await waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_SEARCH, {
        query: 'needle',
        options: { limit: 80, sessionIds: ['message-hit', 'metadata-hit'] },
      });
    });
    await waitFor(() => {
      expect(screen.queryByText('Unrelated title')).not.toBeNull();
    });

    expect(screen.queryByText('Needle metadata')).not.toBeNull();
    expect(screen.queryByText('Needle archived session')).toBeNull();
    expect(screen.queryByText('命中 1 条消息')).not.toBeNull();
  });
});

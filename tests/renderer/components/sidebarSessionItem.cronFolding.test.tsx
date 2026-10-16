// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarProjectGroup } from '../../../src/renderer/components/features/sidebar/SidebarProjectGroup';
import type { SidebarSessionItemSharedProps } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

afterEach(() => cleanup());

function session(id: string, title: string, updatedAt: number) {
  return {
    id,
    title,
    type: 'chat',
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 2,
    turnCount: 1,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
    origin: { kind: 'cron', id: 'job-1' },
  } as any;
}

function sharedSessionProps(overrides: Partial<SidebarSessionItemSharedProps> = {}): SidebarSessionItemSharedProps {
  return {
    unreadSessionIds: new Set(),
    automationSummariesBySessionId: {},
    cronRunAggregatesByTaskId: { 'job-1': { runCount: 3, latestSessionId: 'run-new' } },
    currentSessionId: null,
    selectedSessionIds: new Set(),
    pinnedSessionIds: new Set(),
    renamingId: null,
    sessionRuntimes: new Map(),
    backgroundSessionMap: new Map(),
    sessionStates: {},
    hasNeedsInputForSession: () => false,
    getWaitingDetailForSession: () => undefined,
    searchQuery: '',
    messageSearchHitsBySessionId: {},
    replayEvidenceBySessionId: new Map(),
    reviewItemsBySessionId: {},
    trajectoryQualityBySessionId: {},
    multiSelectMode: false,
    hoveredSession: null,
    renameValue: '',
    renameInputRef: { current: null },
    setHoveredSession: vi.fn(),
    setRenameValue: vi.fn(),
    handleSelectSession: vi.fn(),
    handleContextMenu: vi.fn(),
    handleRenameSubmit: vi.fn(),
    handleRenameKeyDown: vi.fn(),
    handleDoubleClick: vi.fn(),
    handleOpenReplayEvidence: vi.fn(),
    handleSelectMessageSearchHit: vi.fn(),
    handleArchiveSession: vi.fn(),
    ...overrides,
  };
}

function renderGroup(overrides: Partial<Parameters<typeof SidebarProjectGroup>[0]> = {}) {
  return render(
    <SidebarProjectGroup
      group={{
        key: 'project:p1',
        name: 'code-agent',
        path: '/repo/code-agent',
        paths: ['/repo/code-agent'],
        projectId: 'p1',
        isUncategorized: false,
        sessions: [
          session('run-new', '最新运行', 3),
          session('run-old-1', '较早运行一', 2),
          session('run-old-2', '较早运行二', 1),
        ],
        latestActivityAt: 3,
      }}
      projectMetaById={{ p1: { name: 'code-agent' } }}
      setProjectMetaById={vi.fn()}
      hasSearchFilters={false}
      expandedWorkspaces={{}}
      collapsingWorkspaces={{}}
      expandedProjectDetails={{}}
      projectDrawerKey={null}
      isCreatingSession={false}
      creatingWorkspaceKey={null}
      setProjectDrawerKey={vi.fn()}
      setExpandedProjectDetails={vi.fn()}
      handleToggleWorkspaceGroup={vi.fn()}
      handleOpenWorkspaceAssets={vi.fn()}
      handleNewWorkspaceChat={vi.fn()}
      handleOpenProjectArtifactSession={vi.fn()}
      handleStartProjectGoal={vi.fn()}
      handleSelectSession={vi.fn()}
      handleRenameSidebarProject={vi.fn()}
      handleSetSidebarProjectStatus={vi.fn()}
      handleSetSidebarProjectDescription={vi.fn()}
      createWorkspaceChat={vi.fn()}
      openWorkspacePreview={vi.fn()}
      buildProjectDrawerSessions={() => []}
      sessionItemProps={sharedSessionProps()}
      {...overrides}
    />,
  );
}

describe('SidebarProjectGroup cron run folding', () => {
  it('folds older runs, shows xN on the latest row, and expands them locally', () => {
    renderGroup();

    expect(screen.getByTestId('sidebar-session-run-new')).toBeTruthy();
    expect(screen.getByTestId('sidebar-cron-run-count').textContent).toBe('x3');
    expect(screen.queryByTestId('sidebar-session-run-old-1')).toBeNull();
    expect(screen.queryByTestId('sidebar-session-run-old-2')).toBeNull();

    const toggle = screen.getByTestId('sidebar-cron-run-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByTestId('sidebar-session-run-old-1')).toBeTruthy();
    expect(screen.getByTestId('sidebar-session-run-old-2')).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggle);
    expect(screen.queryByTestId('sidebar-session-run-old-1')).toBeNull();
  });

  it('does not fold while search filters are active and never hides the open run', () => {
    const { unmount } = renderGroup({ hasSearchFilters: true });
    expect(screen.getByTestId('sidebar-session-run-old-1')).toBeTruthy();
    expect(screen.getByTestId('sidebar-session-run-old-2')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-cron-run-toggle')).toBeNull();
    unmount();

    renderGroup({
      sessionItemProps: sharedSessionProps({ currentSessionId: 'run-old-2' }),
    });
    expect(screen.getByTestId('sidebar-session-run-old-2')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-session-run-old-1')).toBeNull();
  });
});

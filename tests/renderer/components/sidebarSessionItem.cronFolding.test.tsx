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

  it('expands each task under its own latest row and leaves the group cap in place', () => {
    const selectSession = vi.fn();
    const job = (id: string, taskId: string, title: string, updatedAt: number) => ({
      ...session(id, title, updatedAt),
      origin: { kind: 'cron', id: taskId },
    });
    const plain = (id: string, updatedAt: number) => ({
      ...session(id, id, updatedAt),
      origin: { kind: 'manual' },
    });
    renderGroup({
      group: {
        key: 'project:p1',
        name: 'code-agent',
        path: '/repo/code-agent',
        paths: ['/repo/code-agent'],
        projectId: 'p1',
        isUncategorized: false,
        sessions: [
          job('a-new', 'job-a', '周报最新', 10),
          job('b-new', 'job-b', '新闻最新', 9),
          job('a-old', 'job-a', '周报旧', 8),
          job('b-old', 'job-b', '新闻旧', 7),
          plain('plain-1', 6),
          plain('plain-2', 5),
          plain('plain-3', 4),
          plain('plain-4', 3),
        ],
        latestActivityAt: 10,
      },
      sessionItemProps: sharedSessionProps({
        handleSelectSession: selectSession,
        cronRunAggregatesByTaskId: {
          'job-a': { runCount: 2, latestSessionId: 'a-new' },
          'job-b': { runCount: 2, latestSessionId: 'b-new' },
        },
      }),
    });

    const order = () => Array.from(document.querySelectorAll('[data-testid^="sidebar-session-"]'))
      .map((node) => node.getAttribute('data-testid'));

    expect(order()).toEqual([
      'sidebar-session-a-new',
      'sidebar-session-b-new',
      'sidebar-session-plain-1',
      'sidebar-session-plain-2',
      'sidebar-session-plain-3',
    ]);
    expect(screen.queryByTestId('sidebar-session-plain-4')).toBeNull();

    const toggleA = screen.getByTestId('sidebar-session-a-new').querySelector('[data-testid="sidebar-cron-run-toggle"]');
    expect(toggleA).toBeTruthy();
    expect(toggleA?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggleA as Element);
    expect(selectSession).not.toHaveBeenCalled();
    expect(order()).toEqual([
      'sidebar-session-a-new',
      'sidebar-session-a-old',
      'sidebar-session-b-new',
      'sidebar-session-plain-1',
      'sidebar-session-plain-2',
      'sidebar-session-plain-3',
    ]);
    expect(screen.getByTestId('sidebar-session-a-old').closest('[data-testid="sidebar-cron-older-run"]')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-session-b-old')).toBeNull();
    expect(screen.queryByTestId('sidebar-session-plain-4')).toBeNull();

    const toggleB = screen.getByTestId('sidebar-session-b-new').querySelector('[data-testid="sidebar-cron-run-toggle"]');
    fireEvent.click(toggleB as Element);
    expect(order()).toEqual([
      'sidebar-session-a-new',
      'sidebar-session-a-old',
      'sidebar-session-b-new',
      'sidebar-session-b-old',
      'sidebar-session-plain-1',
      'sidebar-session-plain-2',
      'sidebar-session-plain-3',
    ]);
    const toggles = document.querySelectorAll('[data-testid="sidebar-cron-run-toggle"]');
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle.closest('[data-testid^="sidebar-session-"]')).toBeTruthy();
    }

    fireEvent.click(screen.getByTestId('sidebar-session-a-new').querySelector('[data-testid="sidebar-cron-run-toggle"]') as Element);
    expect(order()).toEqual([
      'sidebar-session-a-new',
      'sidebar-session-b-new',
      'sidebar-session-b-old',
      'sidebar-session-plain-1',
      'sidebar-session-plain-2',
      'sidebar-session-plain-3',
    ]);
    expect(screen.queryByTestId('sidebar-session-a-old')).toBeNull();
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

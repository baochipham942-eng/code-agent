// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarProjectGroup } from '../../../src/renderer/components/features/sidebar/SidebarProjectGroup';
import type { SidebarSessionItemSharedProps } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';
import { splitCronSessionTitleParts } from '../../../src/renderer/utils/sessionPresentation';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';

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

  // ── 返工 2026-10-15：57px 开关把标题挤成「[Schedule] …」，任务名整个被截掉 ──
  it('splits the cron title so only the name truncates and keeps the toggle compact', () => {
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
          job('a-new', 'job-a', '[Schedule] 周报', 10),
          job('a-old', 'job-a', '[Schedule] 周报', 9),
          plain('plain-1', 8),
        ],
        latestActivityAt: 10,
      },
      sessionItemProps: sharedSessionProps({
        cronRunAggregatesByTaskId: { 'job-a': { runCount: 2, latestSessionId: 'a-new' } },
      }),
    });

    // 前缀固定宽（shrink-0），截断只发生在名字段上：行宽吃紧时省略的是名字尾部，
    // 不再出现整段 truncate 把名字吞成「[Schedule] …」。
    const name = screen.getByTestId('sidebar-cron-task-name');
    expect(name.textContent).toBe('周报');
    expect(name.className).toContain('truncate');
    expect(name.className).toContain('min-w-0');
    const prefix = screen.getByTestId('sidebar-cron-task-prefix');
    expect(prefix.textContent).toBe('[Schedule]');
    expect(prefix.className).toContain('shrink-0');
    expect(prefix.contains(name)).toBe(false);

    // 开关必须带 v4 尾缀 ! 的紧凑覆盖：平写 px 会被 GhostButton 的 size 样式
    // 按样式表顺序压掉（57px 开关的来源）。
    const toggle = screen.getByTestId('sidebar-cron-run-toggle');
    expect(toggle.className).toContain('px-0.5!');
    expect(toggle.className).toContain('gap-0.5!');

    // 展开后的旧运行行同样拆段；非 cron 行不拆。
    fireEvent.click(toggle);
    const names = screen.getAllByTestId('sidebar-cron-task-name');
    expect(names.map((node) => node.textContent)).toEqual(['周报', '周报']);
    expect(screen.getAllByTestId('sidebar-cron-task-prefix')).toHaveLength(2);
    expect(screen.getByTestId('sidebar-session-plain-1').querySelector('[data-testid="sidebar-cron-task-name"]')).toBeNull();
  });
});

describe('splitCronSessionTitleParts', () => {
  it('splits schedule, heartbeat and legacy cron prefixes', () => {
    expect(splitCronSessionTitleParts('[Schedule] 周报')).toEqual({ prefix: '[Schedule]', name: '周报' });
    expect(splitCronSessionTitleParts('[Heartbeat] 巡检')).toEqual({ prefix: '[Heartbeat]', name: '巡检' });
    expect(splitCronSessionTitleParts('[Cron] 旧档')).toEqual({ prefix: '[Cron]', name: '旧档' });
  });

  it('returns null for plain titles or a bare prefix', () => {
    expect(splitCronSessionTitleParts('周报')).toBeNull();
    expect(splitCronSessionTitleParts('[Schedule]')).toBeNull();
    expect(splitCronSessionTitleParts('')).toBeNull();
  });
});

// ── 并入自 cronRunMessageView.test.tsx（gates-fast 12 文件上限，收编进同面文件）──
// 不 mock MessageContent / sessionStore / markdown 管线，走真实渲染路径。
const cronRunBody = [
  '可见正文',
  '<cron_snapshot>',
  'SECRET_SNAPSHOT',
  '</cron_snapshot>',
  '<cron_alert>',
  '新发现的冲突',
  '</cron_alert>',
  '<cron_summary>',
  'urgency: fyi',
  '本周汇总完成',
  'artifact: report.md',
  '</cron_summary>',
].join('\n');

function mountCronRunMessage(kind: 'cron' | 'heartbeat' | 'manual') {
  useSessionStore.setState({
    currentSessionId: 'run-1',
    sessions: [{
      id: 'run-1',
      origin: { kind, id: 'job-1' },
      workingDirectory: '/work/run',
    } as never],
  });
  return render(
    <MessageContent
      content={cronRunBody}
      isUser={false}
      messageId="assistant-1"
      mediaContext={{ sessionId: 'run-1' }}
    />,
  );
}

describe('cron run session machine headers', () => {
  afterEach(() => {
    useSessionStore.setState({ sessions: [], currentSessionId: null });
  });

  it('renders a summary card for cron and heartbeat sessions and hides raw tags', async () => {
    for (const kind of ['cron', 'heartbeat'] as const) {
      const view = mountCronRunMessage(kind);
      await waitFor(() => {
        expect(screen.getByTestId('cron-run-summary')).toBeTruthy();
      });
      expect(screen.getByTestId('cron-run-summary').textContent).toContain('本次运行摘要');
      expect(screen.getByTestId('cron-run-summary').textContent).toContain('本周汇总完成');
      expect(screen.getByTestId('cron-alert-body').textContent).toContain('新发现的冲突');
      expect(screen.getByText('可见正文')).toBeTruthy();
      const open = screen.getByTestId('cron-artifact-open');
      expect(open.textContent).toContain('report.md');
      expect(open.getAttribute('title')).toBe('/work/run/report.md');
      expect(view.container.textContent).not.toContain('SECRET_SNAPSHOT');
      expect(view.container.textContent).not.toContain('urgency:');
      expect(view.container.textContent).not.toContain('<cron_');
      view.unmount();
    }
  });

  it('leaves the tags in place for a session that is not a cron or heartbeat run', async () => {
    const view = mountCronRunMessage('manual');
    await waitFor(() => {
      expect(view.container.textContent).toContain('可见正文');
    });
    expect(screen.queryByTestId('cron-run-summary')).toBeNull();
    expect(view.container.textContent).toContain('SECRET_SNAPSHOT');
    expect(view.container.textContent).toContain('urgency: fyi');
  });
});

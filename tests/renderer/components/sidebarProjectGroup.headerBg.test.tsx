// @vitest-environment jsdom
// ============================================================================
// 批P 第五波③ 反向测试：非选中项目组头不得有常驻抬色底色。
// 房规：底色只给 hover / 选中行；组头只允许栏面本色（zinc-950，与 App 侧栏列同一块面），
// 它存在的唯一理由是 sticky 组头要盖住滚过的会话行，肉眼读作无底色。
// 修前 bg-zinc-900 在 zinc-950 栏面上是一块可见的常驻色块（产品负责人截图抓出）。
// ============================================================================
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SidebarProjectGroup } from '../../../src/renderer/components/features/sidebar/SidebarProjectGroup';
import type { SidebarSessionItemSharedProps } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

afterEach(() => {
  cleanup();
  delete (window as any).domainAPI;
  delete (window as any).codeAgentDomainAPI;
});

function sharedSessionProps(currentSessionId: string | null = null): SidebarSessionItemSharedProps {
  return {
    unreadSessionIds: new Set(),
    automationSummariesBySessionId: {},
    currentSessionId,
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
    canOpenSessionReplay: true,
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
    handleOpenSessionReplayInEvalCenter: vi.fn(),
    handleOpenSessionAssets: vi.fn(),
    handleOpenReplayEvidence: vi.fn(),
    handleSelectMessageSearchHit: vi.fn(),
    handleArchiveSession: vi.fn(),
  };
}

function renderGroup(currentSessionId: string | null = null) {
  const props: Parameters<typeof SidebarProjectGroup>[0] = {
    group: {
      key: 'project:p1',
      name: 'code-agent',
      path: '/Users/linchen/Downloads/ai/code-agent',
      paths: ['/Users/linchen/Downloads/ai/code-agent'],
      projectId: 'p1',
      isUncategorized: false,
      sessions: [],
      latestActivityAt: 1700000000000,
    },
    projectMetaById: { p1: { name: 'code-agent' } },
    setProjectMetaById: vi.fn(),
    hasSearchFilters: false,
    expandedWorkspaces: {},
    collapsingWorkspaces: {},
    expandedProjectDetails: {},
    projectDrawerKey: null,
    isCreatingSession: false,
    creatingWorkspaceKey: null,
    setProjectDrawerKey: vi.fn(),
    setExpandedProjectDetails: vi.fn(),
    handleToggleWorkspaceGroup: vi.fn(),
    handleOpenWorkspaceAssets: vi.fn(),
    handleNewWorkspaceChat: vi.fn(),
    handleOpenProjectArtifactSession: vi.fn(),
    handleStartProjectGoal: vi.fn(),
    handleSelectSession: vi.fn(),
    handleRenameSidebarProject: vi.fn(),
    handleSetSidebarProjectStatus: vi.fn(),
    handleSetSidebarProjectDescription: vi.fn(),
    createWorkspaceChat: vi.fn(),
    openWorkspacePreview: vi.fn(),
    buildProjectDrawerSessions: () => [],
    sessionItemProps: sharedSessionProps(currentSessionId),
  };
  return render(<SidebarProjectGroup {...props} />);
}

function groupHeaderClassName(container: HTMLElement): string {
  const root = container.querySelector('[data-sidebar-group-phase]');
  const header = root?.firstElementChild;
  if (!header) throw new Error('组头未渲染');
  return header.className;
}

describe('SidebarProjectGroup 组头底色制度（批P 第五波③）', () => {
  it('非选中组头无抬色底色：不含 bg-zinc-900 / bg-zinc-800 常驻类', () => {
    const { container } = renderGroup(null);
    const cls = groupHeaderClassName(container);
    // 抬色只许出现在 hover: 前缀后面，不许常驻
    expect(cls).not.toMatch(/(?<!hover:)bg-zinc-900/);
    expect(cls).not.toMatch(/(?<!hover:)bg-zinc-800(?!\/)/);
    // 只允许栏面本色（sticky 覆盖用途），肉眼即无底色
    expect(cls).toContain('bg-zinc-950');
  });

  it('hover 提亮制度保留（hover:bg-zinc-800/40）', () => {
    const { container } = renderGroup(null);
    expect(groupHeaderClassName(container)).toContain('hover:bg-zinc-800/40');
  });

  it('当前会话不在本组时同样无抬色底色', () => {
    const { container } = renderGroup('session-other');
    const cls = groupHeaderClassName(container);
    expect(cls).not.toMatch(/(?<!hover:)bg-zinc-900/);
    expect(cls).toContain('bg-zinc-950');
  });
});

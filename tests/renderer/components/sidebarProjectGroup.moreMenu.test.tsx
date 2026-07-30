// @vitest-environment jsdom
// ============================================================================
// 2026-07-28 侧栏工作区入口重构（批2.2）：项目行操作收敛为「⋯」菜单 +「新建」按钮。
//   1. 原 hover 图标簇（设置/控制台/详情/产物）不再独立渲染，全部收进 ⋯ 菜单
//   2. ⋯ 菜单含新增项「选择工作目录」：走 WORKSPACE.selectDirectory，选中后在该目录新建任务
//   3. 「新建」沿用 p.newSessionIn 语义（在该项目下新建会话）
//   4. 未分类组（快速对话）两个按钮都不渲染（保持原行为）
// ============================================================================
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { SidebarProjectGroup } from '../../../src/renderer/components/features/sidebar/SidebarProjectGroup';
import type { SidebarSessionItemSharedProps } from '../../../src/renderer/components/features/sidebar/SidebarSessionItem';

afterEach(() => {
  cleanup();
  delete (window as any).domainAPI;
  delete (window as any).codeAgentDomainAPI;
});

function sharedSessionProps(): SidebarSessionItemSharedProps {
  return {
    unreadSessionIds: new Set(),
    automationSummariesBySessionId: {},
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
  };
}

function renderGroup(overrides: Partial<Parameters<typeof SidebarProjectGroup>[0]> = {}) {
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
    sessionItemProps: sharedSessionProps(),
    ...overrides,
  };
  return { props, ...render(<SidebarProjectGroup {...props} />) };
}

describe('SidebarProjectGroup ⋯ 菜单 + 新建（2026-07-28 重构）', () => {
  it('项目行只渲染 ⋯ 与 新建两个操作按钮，旧图标簇收进菜单', () => {
    const { getByRole, queryByRole } = renderGroup();
    expect(getByRole('button', { name: 'code-agent 更多操作' })).toBeTruthy();
    expect(getByRole('button', { name: '在 code-agent 新建会话' })).toBeTruthy();
    // 菜单未开时，原独立按钮不存在
    expect(queryByRole('button', { name: '打开项目控制台' })).toBeNull();
    expect(queryByRole('menuitem')).toBeNull();
  });

  it('⋯ 菜单收齐原 hover 功能并新增「选择工作目录」', () => {
    const { getByRole, getAllByRole } = renderGroup();
    fireEvent.click(getByRole('button', { name: 'code-agent 更多操作' }));
    const items = getAllByRole('menuitem').map((el) => el.textContent);
    expect(items).toEqual([
      '编辑项目',
      // 菜单项不带项目名（2026-07-28 拍板）：窄侧栏里会折两行，且菜单容器 aria-label 已含项目名
      '打开项目控制台',
      '展开项目详情',
      '产物与资产',
      '选择工作目录',
    ]);
  });

  it('「选择工作目录」走 WORKSPACE.selectDirectory 并在选中目录下新建任务', async () => {
    const invoke = vi.fn(async () => ({ success: true, data: '/picked/dir' }));
    (window as any).domainAPI = { invoke };
    const createWorkspaceChat = vi.fn();
    const { getByRole, queryByRole } = renderGroup({ createWorkspaceChat });

    fireEvent.click(getByRole('button', { name: 'code-agent 更多操作' }));
    fireEvent.click(getByRole('menuitem', { name: '选择工作目录' }));

    await waitFor(() => {
      expect(createWorkspaceChat).toHaveBeenCalledWith('/picked/dir', '/picked/dir');
    });
    expect(invoke).toHaveBeenCalledWith('domain:workspace', 'selectDirectory', undefined);
    // 菜单选中后关闭
    expect(queryByRole('menuitem')).toBeNull();
  });

  it('菜单里的「打开控制台」保持原行为（打开项目抽屉并关菜单）', () => {
    const setProjectDrawerKey = vi.fn();
    const { getByRole, queryByRole } = renderGroup({ setProjectDrawerKey });
    fireEvent.click(getByRole('button', { name: 'code-agent 更多操作' }));
    fireEvent.click(getByRole('menuitem', { name: '打开项目控制台' }));
    expect(setProjectDrawerKey).toHaveBeenCalledWith('project:p1');
    expect(queryByRole('menuitem')).toBeNull();
  });

  it('未分类组（快速对话）不渲染 ⋯ 与 新建', () => {
    const { queryByRole } = renderGroup({
      group: {
        key: '__uncategorized__',
        name: '快速对话',
        path: '',
        paths: [],
        isUncategorized: true,
        sessions: [],
        latestActivityAt: 1700000000000,
      },
      projectMetaById: {},
    });
    expect(queryByRole('button', { name: /更多操作/ })).toBeNull();
    expect(queryByRole('button', { name: /新建会话/ })).toBeNull();
  });
});

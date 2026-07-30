// ============================================================================
// sidebar.tierSections.test.tsx —— 侧栏会话列表三分区节头交互（折叠/只看本分区/创建）。
// renderToStaticMarkup + 全 mock store + 真实 zh i18n，与 sidebar.newSessionButton.test.ts 同套路。
// SidebarProjectGroup 打桩：节头逻辑与被 mock 的分组渲染解耦，组内容用一个 testid 代表。
// ============================================================================

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const sessionUiState = {
  collapsedTiers: {} as Record<string, boolean>,
  setTierCollapsed: vi.fn(),
};

const appState = {
  openProjectSpacePage: vi.fn(),
};

vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: (selector?: (state: typeof sessionUiState) => unknown) =>
    selector ? selector(sessionUiState) : sessionUiState,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) =>
    selector ? selector(appState) : appState,
}));

vi.mock('../../../src/renderer/components/features/sidebar/SidebarProjectGroup', () => ({
  SidebarProjectGroup: ({ group }: { group: { key: string } }) =>
    React.createElement('div', { 'data-testid': `sidebar-project-group-${group.key}` }),
}));

import { SidebarSessionList } from '../../../src/renderer/components/features/sidebar/SidebarSessionList';

// 三个分区各一组：协作空间（meta.spacePromotedAt 非空）/ 独立空间（有 projectId 未升级）/ 快速对话（无 projectId）。
const groups = [
  { key: 'g-space', projectId: 'p1', sessions: [{ id: 's1' }] },
  { key: 'g-project', projectId: 'p2', sessions: [{ id: 's2' }, { id: 's3' }] },
  { key: 'g-quick', projectId: null, sessions: [{ id: 's4' }] },
];

const projectMetaById = {
  p1: { spacePromotedAt: 123 },
  p2: {},
};

function renderList(overrides: Record<string, unknown> = {}): string {
  const props = {
    groups,
    isLoading: false,
    hasAnySessions: true,
    filteredSessionsEmpty: false,
    messageSearchLoading: false,
    searchQuery: '',
    sessionStatusFilter: 'all',
    activeStatusFilterLabel: '',
    hasSearchFilters: false,
    projectMetaById,
    setProjectMetaById: vi.fn(),
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
    sessionItemProps: {
      backgroundSessionMap: new Map(),
      sessionRuntimes: new Map(),
      sessionStates: {},
      hasNeedsInputForSession: () => false,
      replayEvidenceBySessionId: new Map(),
      reviewItemsBySessionId: {},
      currentSessionId: null,
    },
    cloudBadge: false,
    handleNewChat: vi.fn(),
    ...overrides,
  } as unknown as React.ComponentProps<typeof SidebarSessionList>;
  return renderToStaticMarkup(React.createElement(SidebarSessionList, props));
}

describe('SidebarSessionList tier section headers', () => {
  beforeEach(() => {
    sessionUiState.collapsedTiers = {};
    sessionUiState.setTierCollapsed.mockReset();
    appState.openProjectSpacePage.mockReset();
  });

  it('renders each tier header as a keyboard-reachable toggle button with a persistent count', () => {
    const html = renderList();

    for (const tier of ['space', 'project', 'quick'] as const) {
      expect(html).toContain(`data-testid="sidebar-tier-${tier}"`);
      // 原生 button（键盘 Enter/Space 天然可达）+ aria-expanded 语义
      expect(html).toContain(`data-testid="sidebar-tier-toggle-${tier}"`);
      expect(html).toContain('aria-expanded="true"');
    }
    // 计数：space=1 / project=2 / quick=1
    expect(html).toContain('>1</span>');
    expect(html).toContain('>2</span>');
    // 默认展开：组内容在
    expect(html).toContain('data-testid="sidebar-project-group-g-space"');
    expect(html).toContain('data-testid="sidebar-project-group-g-project"');
    expect(html).toContain('data-testid="sidebar-project-group-g-quick"');
  });

  it('hides group content when collapsed but keeps the header count', () => {
    sessionUiState.collapsedTiers = { project: true };
    const html = renderList();

    const section = html.match(/data-testid="sidebar-tier-project"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(section).toContain('aria-expanded="false"');
    // 折叠态计数仍在
    expect(section).toContain('>2</span>');
    // 组内容消失
    expect(section).not.toContain('data-testid="sidebar-project-group-g-project"');
    // 其它分区不受影响
    expect(html).toContain('data-testid="sidebar-project-group-g-space"');
    expect(html).toContain('data-testid="sidebar-project-group-g-quick"');
  });

  it('renders a create button for space and quick tiers but not for project tier', () => {
    const html = renderList();

    // 协作空间「+」→ 空间列表页（新建空间 Modal 所在）；快速对话「+」→ 新会话
    expect(html).toContain('data-testid="sidebar-tier-new-space"');
    expect(html).toContain('data-testid="sidebar-tier-new-quick"');
    // 独立空间分区没有现成「新建项目」入口，不放「+」
    expect(html).not.toContain('data-testid="sidebar-tier-new-project"');
    expect(html).toContain('新建协作空间');
    expect(html).toContain('新建快速对话');
  });


});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPlaywrightChromium } from '../../../src/host/agent/runtime/browser/playwrightRuntime';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = { collapsedTiers: {}, setTierCollapsed: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = { openProjectSpacePage: vi.fn() };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../src/renderer/components/ProjectSettingsDialog', () => ({
  ProjectSettingsDialog: () => null,
}));

import { SidebarSessionList } from '../../../src/renderer/components/features/sidebar/SidebarSessionList';

interface AxisMetric {
  centerX: number;
  horizontalOffsetPx: number;
  verticalOffsetPx: number;
}

interface TrailingGeometry {
  rowRight: number;
  axisX: number;
  tierPlus: Record<string, AxisMetric>;
  groupCount: AxisMetric;
  groupNewSession: AxisMetric;
}

function session(id: string, projectId?: string) {
  return {
    id,
    title: id,
    type: 'chat',
    status: 'interrupted',
    projectId,
    workingDirectory: projectId ? `/repo/${projectId}` : null,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    turnCount: 1,
    modelConfig: { provider: 'openai', model: 'gpt-5' },
  } as any;
}

function renderSidebar(): string {
  const groups = [
    {
      key: 'project:space',
      name: 'space',
      path: '/repo/space',
      paths: ['/repo/space'],
      projectId: 'space',
      isUncategorized: false,
      sessions: [session('space-session', 'space')],
      latestActivityAt: 3,
    },
    {
      key: 'project:project',
      name: 'project',
      path: '/repo/project',
      paths: ['/repo/project'],
      projectId: 'project',
      isUncategorized: false,
      sessions: [session('project-session', 'project')],
      latestActivityAt: 2,
    },
    {
      key: '__chats__',
      name: 'quick',
      paths: [],
      isUncategorized: true,
      sessions: [session('quick-session')],
      latestActivityAt: 1,
    },
  ];

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
    projectMetaById: {
      space: { name: 'space', spacePromotedAt: 1 },
      project: { name: 'project', spacePromotedAt: null },
    },
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
      renameInputRef: React.createRef<HTMLInputElement>(),
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
    },
    cloudBadge: true,
    handleNewChat: vi.fn(),
    handleNewIndependentSpace: vi.fn(),
  } as unknown as React.ComponentProps<typeof SidebarSessionList>;

  return renderToStaticMarkup(<SidebarSessionList {...props} />);
}

describe('Sidebar trailing 列全列双轴几何', () => {
  let vite: ViteDevServer;
  let browser: Browser;
  let page: Page;
  let geometry: TrailingGeometry;

  beforeAll(async () => {
    vite = await createServer({
      configFile: 'vite.config.ts',
      root: 'src/renderer',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    await vite.listen();
    const origin = vite.resolvedUrls?.local[0];
    if (!origin) throw new Error('Vite test origin unavailable');

    const playwright = await loadPlaywrightChromium();
    if (!playwright.ok || !playwright.chromium) {
      throw new Error(`Playwright Chromium unavailable: ${playwright.error ?? 'unknown error'}`);
    }
    browser = await playwright.chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 420, height: 520 }, deviceScaleFactor: 2 });
    await page.setContent(
      `<!doctype html><html><head><link rel="stylesheet" href="${origin}styles/global.css"></head>`
      + `<body class="bg-zinc-950 text-zinc-200"><main style="width:240px;margin:40px">${renderSidebar()}</main></body></html>`,
      { waitUntil: 'networkidle' },
    );
    await page.locator('[data-sidebar-group-phase] > div:first-child').first().hover();
    geometry = await readGeometry(page);
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  it('三个 tier 的 + 都与会话状态轴心对心，且在节头内容行内垂直居中', () => {
    console.info('[trailing-axis tier-plus]', JSON.stringify({
      rowRight: geometry.rowRight,
      axisX: geometry.axisX,
      tierPlus: geometry.tierPlus,
    }));
    expect(Object.keys(geometry.tierPlus)).toEqual(['space', 'project', 'quick']);
    for (const metric of Object.values(geometry.tierPlus)) {
      expect(Math.abs(metric.horizontalOffsetPx)).toBeLessThanOrEqual(1);
      expect(metric.verticalOffsetPx).toBeCloseTo(0, 2);
    }
  });

  it('项目组常驻计数与 hover 最右新建图标共用状态轴和组头垂直中心', () => {
    console.info('[trailing-axis project-group]', JSON.stringify({
      rowRight: geometry.rowRight,
      axisX: geometry.axisX,
      groupCount: geometry.groupCount,
      groupNewSession: geometry.groupNewSession,
    }));
    for (const metric of [geometry.groupCount, geometry.groupNewSession]) {
      expect(Math.abs(metric.horizontalOffsetPx)).toBeLessThanOrEqual(1);
      expect(Math.abs(metric.verticalOffsetPx)).toBeLessThanOrEqual(1);
    }
  });
});

async function readGeometry(page: Page): Promise<TrailingGeometry> {
  return page.evaluate(`(() => {
    const rect = (element) => {
      if (!element) throw new Error('trailing-axis fixture element missing');
      return element.getBoundingClientRect();
    };
    const centerX = (value) => value.left + value.width / 2;
    const centerY = (value) => value.top + value.height / 2;
    const sessionRow = document.querySelector('[data-session-id]');
    const sessionRect = rect(sessionRow);
    const axisX = sessionRect.right - 14;
    const metric = (element, row) => {
      const elementRect = rect(element);
      const rowRect = rect(row);
      return {
        centerX: centerX(elementRect),
        horizontalOffsetPx: centerX(elementRect) - axisX,
        verticalOffsetPx: centerY(elementRect) - centerY(rowRect),
      };
    };
    const tierPlus = {};
    for (const tier of ['space', 'project', 'quick']) {
      const section = document.querySelector('[data-testid="sidebar-tier-' + tier + '"]');
      const toggle = section?.querySelector('[data-testid="sidebar-tier-toggle-' + tier + '"]');
      const plus = section?.querySelector('[data-testid="sidebar-tier-new-' + tier + '"] svg');
      tierPlus[tier] = metric(plus, toggle);
    }
    const groupHeader = document.querySelector('[data-sidebar-group-phase] > div:first-child');
    const groupCount = groupHeader?.querySelector('[data-testid="sidebar-group-unfinished"]');
    const actionContainer = groupHeader?.querySelector(':scope > div.absolute');
    const groupNewSession = actionContainer?.querySelector(':scope > button > svg');
    return {
      rowRight: sessionRect.right,
      axisX,
      tierPlus,
      groupCount: metric(groupCount, groupHeader),
      groupNewSession: metric(groupNewSession, groupHeader),
    };
  })()`);
}

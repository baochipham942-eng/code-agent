 
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh, language: 'zh' }) };
});

const reactState = vi.hoisted(() => ({
  useStateCalls: 0,
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useState: (initial: unknown) => {
      reactState.useStateCalls += 1;
      // 第 4 个 useState = showUserMenu（批C2 在组件头部新增 isNativeFullscreen 后顺延一位）
      if (reactState.useStateCalls === 4) {
        return [true, vi.fn()] as const;
      }
      return actual.useState(initial);
    },
  };
});

const sessionState = {
  sessions: [] as any[],
  currentSessionId: null as string | null,
  messages: [] as any[],
  todos: [] as any[],
  isLoading: false,
  createSession: vi.fn(async () => null),
  switchSession: vi.fn(async () => {}),
  archiveSession: vi.fn(async () => {}),
  unarchiveSession: vi.fn(async () => {}),
  unreadSessionIds: new Set<string>(),
  sessionRuntimes: new Map(),
  backgroundSessions: [] as any[],
  renameSession: vi.fn(async () => {}),
};

const selectionState = {
  pinnedSessionIds: new Set<string>(),
  togglePin: vi.fn(),
  multiSelectMode: false,
  toggleMultiSelect: vi.fn(),
  selectedSessionIds: new Set<string>(),
  toggleSelection: vi.fn(),
  clearSelection: vi.fn(),
  batchDelete: vi.fn(),
};

const sessionUiState = {
	  searchQuery: '',
	  setSearchQuery: vi.fn(),
	  sessionStatusFilter: 'all',
	  setSessionStatusFilter: vi.fn(),
  trajectoryTierFilter: 'all',
  setTrajectoryTierFilter: vi.fn(),
  trajectoryFailureFilter: 'all',
  setTrajectoryFailureFilter: vi.fn(),
  trajectoryReviewFilter: 'all',
  setTrajectoryReviewFilter: vi.fn(),
  pendingSearchJump: null,
  setPendingSearchJump: vi.fn(),
  softDelete: vi.fn(),
  undoDelete: vi.fn(),
  pendingDelete: null,
  expandedWorkspaces: {},
  setWorkspaceExpanded: vi.fn(),
};

const appState = {
  clearPlanningState: vi.fn(),
  setShowSettings: vi.fn(),
  openSettingsTab: vi.fn(),
  setShowPromptManager: vi.fn(),
  showEvalCenter: false,
  setShowEvalCenter: vi.fn(),
  openEvalCenter: vi.fn(),
  setWorkingDirectory: vi.fn(),
  showLab: false,
  setShowLab: vi.fn(),
  showCronCenter: false,
  setShowCronCenter: vi.fn(),
  showTimeCapabilityCenter: false,
  setShowTimeCapabilityCenter: vi.fn(),
  showDesktopPanel: false,
  setShowDesktopPanel: vi.fn(),
  showActivityPanel: false,
  setShowActivityPanel: vi.fn(),
  showKnowledgeMemoryPanel: false,
  setShowKnowledgeMemoryPanel: vi.fn(),
  showDAGPanel: false,
  setShowDAGPanel: vi.fn(),
};

const authState = {
  user: {
    id: 'user-admin',
    nickname: 'Dad',
    email: 'dad@example.com',
    avatarUrl: null,
    isAdmin: true,
  },
  isAuthenticated: true,
  sessionTrustState: 'verified',
  authBackendAvailable: true,
  hasCachedAdminClaim: false,
  setShowAuthModal: vi.fn(),
  signOut: vi.fn(async () => {}),
};

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector?: (state: typeof sessionState) => unknown) => selector ? selector(sessionState) : sessionState,
  initializeSessionStore: vi.fn(async () => {}),
}));

vi.mock('../../../src/renderer/stores/selectionStore', () => ({
  useSelectionStore: (selector?: (state: typeof selectionState) => unknown) => selector ? selector(selectionState) : selectionState,
}));

vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: (selector?: (state: typeof sessionUiState) => unknown) => selector ? selector(sessionUiState) : sessionUiState,
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: typeof appState) => unknown) => selector ? selector(appState) : appState,
}));

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector?: (state: typeof authState) => unknown) => selector ? selector(authState) : authState,
}));

vi.mock('../../../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector?: (state: { sessionStates: Record<string, unknown> }) => unknown) =>
    selector ? selector({ sessionStates: {} }) : { sessionStates: {} },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
    on: vi.fn(),
  },
}));

import { Sidebar, isAccountMenuEventOutside } from '../../../src/renderer/components/Sidebar';

describe('Sidebar account menu entry planning', () => {
  beforeEach(() => {
    reactState.useStateCalls = 0;
    authState.user.isAdmin = true;
    authState.sessionTrustState = 'verified';
    authState.authBackendAvailable = true;
    authState.hasCachedAdminClaim = false;
  });

  it('keeps common entries visible and groups advanced tools behind one disclosure', () => {
    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('用户菜单');
    expect(html).toContain('管理员');
    expect(html).toContain('常用');
    expect(html).toContain('活动');
    expect(html).toContain('本机操作');
    // 「协作请求（@neo）」入口 2026-07-29 爸拍板拿掉（家=协作空间任务 tab），反向钉死
    expect(html).not.toContain('协作请求（@neo）');
    // 评测中心（2026-07 v1）：admin-only 菜单项
    expect(html).toContain('评测中心');
    // 提示词管理（2026-07-27 拍板）：admin-only 工具，回到账号菜单与评测中心同档
    expect(html).toContain('提示词管理');
    expect(html).toContain('高级工具');
    expect(html).toContain('设置');
    expect(html).toContain('退出登录');
    // 方案 9C 移出的入口：知识与记忆并入资料库，高级定时任务走能力区/自动化面板，
    // 用户管理/邀请码迁 admin-console——admin 也不该再看到
    expect(html).not.toContain('知识与记忆');
    expect(html).not.toContain('高级定时任务');
    expect(html).not.toContain('用户管理');
    expect(html).not.toContain('邀请码管理');
    expect(html).not.toContain('模型训练');
    expect(html).not.toContain('时间与能力');
    expect(html).not.toContain('桌面采集');
    expect(html).not.toContain('Computer Use');
    expect(html).not.toContain('In-App 验证');
  });

  // 2026-07-27 产品负责人实测「双击标题栏没反应」：Tauri 的 WKWebView 不认 Electron 的
  // -webkit-app-region，拖拽/双击缩放必须靠 data-tauri-drag-region 属性；属性掉了不会有测试自己红。
  it('侧栏顶行是 Tauri 拖拽区，且图标右对齐钉在侧栏右轨上（2026-07-27 二次拍板）', () => {
    reactState.useStateCalls = 0;
    const html = renderToStaticMarkup(React.createElement(Sidebar));
    expect(html).toContain('data-tauri-drag-region');
    // 顶行 = 左槽（红绿灯不在场时挂品牌标）+ 右侧功能图标簇，justify-between 把图标簇推到右轨。
    // 图标数量随权限变化（筛选钮仅管理员可见），左对齐的绝对内边距守不住这条轨，所以钉布局方式。
    expect(html).toContain('justify-between');
    expect(html).not.toContain('justify-start');
    // px-0.5 比别处小 8：本行图标是 32px IconButton（16 字形居中 ⇒ 框内自带 8 内缩），
    // 而角标/状态点/箭头是裸 16px 字形；喂同一个 px 值右轨会断开（实测 206.8 vs 214.8）。
    expect(html).toContain('px-0.5');
  });

  it('提示词管理只对 admin 出现在账号菜单（2026-07-27 拍板：它是管理员工具，不进设置页/能力中心）', () => {
    reactState.useStateCalls = 0;
    authState.user.isAdmin = true;
    authState.sessionTrustState = 'verified';
    const adminHtml = renderToStaticMarkup(React.createElement(Sidebar));
    expect(adminHtml).toContain('提示词管理');

    reactState.useStateCalls = 0;
    authState.user.isAdmin = false;
    const memberHtml = renderToStaticMarkup(React.createElement(Sidebar));
    expect(memberHtml).not.toContain('提示词管理');
  });

  it('keeps internal validation tools out of the account menu for admins and members', () => {
    const adminHtml = renderToStaticMarkup(React.createElement(Sidebar));

    expect(adminHtml).not.toContain('Computer Use');
    expect(adminHtml).not.toContain('In-App 验证');

    reactState.useStateCalls = 0;
    authState.user.isAdmin = false;
    const memberHtml = renderToStaticMarkup(React.createElement(Sidebar));

    expect(memberHtml).not.toContain('用户管理');
    expect(memberHtml).not.toContain('邀请码管理');
    expect(memberHtml).not.toContain('评测中心');
    expect(memberHtml).not.toContain('Computer Use');
    expect(memberHtml).not.toContain('In-App 验证');
  });

  it('shows a pending admin badge for cached admin sessions without granting admin menu entries', () => {
    reactState.useStateCalls = 0;
    authState.user.isAdmin = false;
    authState.sessionTrustState = 'cached';
    authState.authBackendAvailable = false;
    authState.hasCachedAdminClaim = true;

    const html = renderToStaticMarkup(React.createElement(Sidebar));

    expect(html).toContain('管理员待验证');
    expect(html).toContain('登录服务启动失败，管理员身份暂时不能验证');
    expect(html).not.toContain('用户管理');
    expect(html).not.toContain('邀请码管理');
  });

  it('detects outside targets for account menu dismissal', () => {
    const inside = {} as Node;
    const outside = {} as Node;
    const menu = {
      contains: vi.fn((node: Node) => node === inside),
    };

    expect(isAccountMenuEventOutside(menu, inside)).toBe(false);
    expect(isAccountMenuEventOutside(menu, outside)).toBe(true);
    expect(isAccountMenuEventOutside(null, outside)).toBe(false);
  });
});

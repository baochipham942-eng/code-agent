import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const composerState = {
  workingDirectory: '/repo/app',
  routingMode: 'auto',
  targetAgentIds: [] as string[],
  browserSessionMode: 'none' as 'none' | 'managed' | 'desktop',
  selectedSkillIds: [] as string[],
  selectedConnectorIds: [] as string[],
  selectedMcpServerIds: [] as string[],
  setWorkingDirectory: vi.fn(),
  setRoutingMode: vi.fn(),
  setTargetAgentIds: vi.fn(),
  setBrowserSessionMode: vi.fn(),
  setSelectedSkillIds: vi.fn(),
  setSelectedConnectorIds: vi.fn(),
  setSelectedMcpServerIds: vi.fn(),
};

const appState = {
  setWorkingDirectory: vi.fn(),
  selectedSwarmAgentId: null as string | null,
  openSettingsTab: vi.fn(),
  setShowDesktopPanel: vi.fn(),
};

const sessionState = {
  currentSessionId: 'session-1',
};

const skillState = {
  mountedSkills: [
    {
      skillName: 'review-skill',
      libraryId: 'core',
      mountedAt: 1,
      source: 'manual',
    },
  ],
  setCurrentSession: vi.fn(),
  mountSkill: vi.fn(),
};

const swarmState = {
  agents: [
    {
      id: 'agent-builder',
      name: 'builder',
      role: 'builder-role',
    },
    {
      id: 'agent-reviewer',
      name: 'reviewer',
      role: 'reviewer-role',
    },
  ],
};

const quickActionState = {
  runningActionKey: null as string | null,
  actionErrors: {} as Record<string, string>,
  completedActions: {} as Record<string, { kind: string; completedAt: number }>,
  runQuickAction: vi.fn(),
};

const browserWorkbenchState = {
  managedSession: {
    running: false,
    tabCount: 0,
    activeTab: null as { id: string; url: string; title: string } | null,
  },
  preview: null as null | {
    mode: 'managed' | 'desktop';
    url?: string | null;
    title?: string | null;
    frontmostApp?: string | null;
    lastScreenshotAtMs?: number | null;
  },
  readinessItems: [] as Array<{
    key: string;
    label: string;
    ready: boolean;
    value: string;
    detail?: string | null;
  }>,
  blocked: false,
  blockedDetail: undefined as string | undefined,
  blockedHint: undefined as string | undefined,
  repairActions: [] as Array<{ kind: string; label: string }>,
  busyActionKind: null as string | null,
  actionError: null as string | null,
  refresh: vi.fn(async () => {}),
  runRepairAction: vi.fn(async () => {}),
};

vi.mock('../../../src/renderer/stores/composerStore', () => ({
  useComposerStore: (selector: (state: any) => unknown) =>
    selector(composerState),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector: (state: any) => unknown) =>
    selector(appState),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: any) => unknown) =>
    selector(sessionState),
}));

vi.mock('../../../src/renderer/stores/skillStore', () => ({
  useSkillStore: (selector: (state: any) => unknown) =>
    selector(skillState),
}));

vi.mock('../../../src/renderer/stores/swarmStore', () => ({
  useSwarmStore: (selector: (state: any) => unknown) =>
    selector(swarmState),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(),
    invokeDomain: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({
    items: [],
    skills: [
      {
        kind: 'skill',
        key: 'skill:review-skill',
        id: 'review-skill',
        label: 'review-skill',
        selected: composerState.selectedSkillIds.includes('review-skill'),
        mounted: true,
        installState: 'mounted',
        description: 'Review code changes',
        source: 'library',
        libraryId: 'core',
        available: true,
        blocked: false,
        visibleInWorkbench: true,
        health: 'healthy',
        lifecycle: {
          installState: 'installed',
          mountState: 'mounted',
          connectionState: 'not_applicable',
        },
      },
      ...(composerState.selectedSkillIds.includes('draft-skill')
        ? [{
          kind: 'skill' as const,
          key: 'skill:draft-skill',
          id: 'draft-skill',
          label: 'draft-skill',
          selected: true,
          mounted: false,
          installState: 'available',
          description: 'Draft release notes',
          source: 'community',
          libraryId: 'community',
          available: false,
          blocked: true,
          visibleInWorkbench: true,
          health: 'inactive',
          lifecycle: {
            installState: 'installed',
            mountState: 'unmounted',
            connectionState: 'not_applicable' as const,
          },
          blockedReason: {
            code: 'skill_not_mounted',
            detail: 'Skill draft-skill 已安装但未挂载，本轮不会调用。',
            hint: '去 TaskPanel/Skills 把它挂到当前会话。',
            severity: 'warning' as const,
          },
        }]
        : []),
    ],
    connectors: [
      {
        kind: 'connector',
        key: 'connector:mail',
        id: 'mail',
        label: 'mail',
        selected: composerState.selectedConnectorIds.includes('mail'),
        connected: true,
        detail: 'ready',
        capabilities: ['list_messages'],
        available: true,
        blocked: false,
        visibleInWorkbench: true,
        health: 'healthy',
        lifecycle: {
          installState: 'not_applicable',
          mountState: 'not_applicable',
          connectionState: 'connected',
        },
      },
      ...(composerState.selectedConnectorIds.includes('calendar')
        ? [{
          kind: 'connector' as const,
          key: 'connector:calendar',
          id: 'calendar',
          label: 'calendar',
          selected: true,
          connected: false,
          detail: 'offline',
          capabilities: ['list_events'],
          available: false,
          blocked: true,
          visibleInWorkbench: true,
          health: 'inactive',
          lifecycle: {
            installState: 'not_applicable' as const,
            mountState: 'not_applicable' as const,
            connectionState: 'disconnected' as const,
          },
          blockedReason: {
            code: 'connector_disconnected',
            detail: 'Connector calendar 当前未连接，本轮不会调用。',
            hint: '当前没有一键连接入口，先在本地应用里完成授权/可用性检查，再重新发送。',
            severity: 'warning' as const,
          },
        }]
        : []),
    ],
    mcpServers: [
      {
        kind: 'mcp',
        key: 'mcp:github',
        id: 'github',
        label: 'github',
        selected: composerState.selectedMcpServerIds.includes('github'),
        status: 'connected',
        enabled: true,
        transport: 'stdio',
        toolCount: 2,
        resourceCount: 1,
        available: true,
        blocked: false,
        visibleInWorkbench: true,
        health: 'healthy',
        lifecycle: {
          installState: 'not_applicable',
          mountState: 'not_applicable',
          connectionState: 'connected',
        },
      },
      ...(composerState.selectedMcpServerIds.includes('slack')
        ? [{
          kind: 'mcp' as const,
          key: 'mcp:slack',
          id: 'slack',
          label: 'slack',
          selected: true,
          status: 'error' as const,
          enabled: true,
          transport: 'stdio' as const,
          toolCount: 0,
          resourceCount: 0,
          error: 'handshake failed',
          available: false,
          blocked: true,
          visibleInWorkbench: true,
          health: 'error' as const,
          lifecycle: {
            installState: 'not_applicable' as const,
            mountState: 'not_applicable' as const,
            connectionState: 'error' as const,
          },
          blockedReason: {
            code: 'mcp_error',
            detail: 'MCP slack 当前状态为 error，本轮不会调用。',
            hint: '去 MCP Settings 查看报错并修复后重试。',
            severity: 'error' as const,
          },
        }]
        : []),
    ],
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner', () => ({
  useWorkbenchCapabilityQuickActionRunner: () => quickActionState,
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchBrowserSession', () => ({
  useWorkbenchBrowserSession: () => browserWorkbenchState,
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchInsights', () => ({
  useWorkbenchInsights: () => ({
    history: [
      {
        kind: 'connector',
        id: 'mail',
        label: 'mail',
        count: 1,
        lastUsed: 100,
        topActions: [{ label: 'send', count: 1 }],
      },
    ],
  }),
}));

import { InlineWorkbenchBar } from '../../../src/renderer/components/features/chat/InlineWorkbenchBar';

describe('InlineWorkbenchBar mention preview', () => {
  beforeEach(() => {
    composerState.workingDirectory = '/repo/app';
    composerState.routingMode = 'auto';
    composerState.targetAgentIds = [];
    composerState.browserSessionMode = 'none';
    composerState.selectedSkillIds = [];
    composerState.selectedConnectorIds = [];
    composerState.selectedMcpServerIds = [];
    quickActionState.runningActionKey = null;
    quickActionState.actionErrors = {};
    quickActionState.completedActions = {};
    browserWorkbenchState.managedSession = {
      running: false,
      tabCount: 0,
      activeTab: null,
    };
    browserWorkbenchState.preview = null;
    browserWorkbenchState.readinessItems = [];
    browserWorkbenchState.blocked = false;
    browserWorkbenchState.blockedDetail = undefined;
    browserWorkbenchState.blockedHint = undefined;
    browserWorkbenchState.repairActions = [];
    browserWorkbenchState.busyActionKind = null;
    browserWorkbenchState.actionError = null;
  });

  it('shows override banner when leading @agent routing overrides the current selection', () => {
    composerState.routingMode = 'auto';
    composerState.targetAgentIds = [];
    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar, {
        previewTargetAgentIds: ['agent-reviewer'],
      }),
    );

    expect(html).toContain('本次发送以前缀 @agent 为准，会覆盖当前 Routing 选择');
    expect(html).toContain('reviewer');
    expect(html).toContain('app');
  });

  it('keeps the lighter mention preview hint when preview matches the current direct target', () => {
    composerState.routingMode = 'direct';
    composerState.targetAgentIds = ['agent-reviewer'];

    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar, {
        previewTargetAgentIds: ['agent-reviewer'],
      }),
    );

    expect(html).toContain('本次发送由开头 @agent 指定');
    expect(html).not.toContain('会覆盖当前 Routing 选择');
  });

  it('shows direct routing hint when direct mode is selected without mention preview', () => {
    composerState.routingMode = 'direct';
    composerState.targetAgentIds = ['agent-reviewer'];

    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar),
    );

    expect(html).toContain('这条消息会发给 reviewer');
    expect(html).toContain('也可以直接输入 @reviewer');
  });

  it('renders mounted skill chips inside the workbench bar', () => {
    composerState.routingMode = 'auto';
    composerState.targetAgentIds = [];
    composerState.selectedSkillIds = ['review-skill'];

    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar),
    );

    expect(html).toContain('Skills');
    expect(html).toContain('review-skill');
    expect(html).toContain('查看 review-skill 详情');
  });

  it('renders selected connector chips inside the workbench bar', () => {
    composerState.routingMode = 'auto';
    composerState.targetAgentIds = [];
    composerState.selectedConnectorIds = ['mail'];

    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar),
    );

    expect(html).toContain('Connectors');
    expect(html).toContain('mail');
    expect(html).toContain('查看 mail 详情');
  });

  it('renders quick actions for a selected but unmounted skill', () => {
    composerState.selectedSkillIds = ['draft-skill'];

    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar),
    );

    expect(html).toContain('Quick Actions');
    expect(html).toContain('draft-skill');
    expect(html).toContain('挂载');
  });

  it('renders the blocked connector hint without a fake one-step action', () => {
    composerState.selectedConnectorIds = ['calendar'];

    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar),
    );

    expect(html).toContain('calendar');
    expect(html).toContain('当前没有一键连接入口');
    expect(html).not.toContain('打开设置');
  });

  it('renders retry and settings shortcuts for a blocked MCP server', () => {
    composerState.selectedMcpServerIds = ['slack'];

    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar),
    );

    expect(html).toContain('slack');
    expect(html).toContain('重连');
    expect(html).toContain('打开设置');
  });

  it('shows a repaired capability in the ready-next-turn section after a completed quick action', () => {
    composerState.selectedSkillIds = ['review-skill'];
    quickActionState.completedActions = {
      'skill:review-skill': {
        kind: 'mount_skill',
        completedAt: 1,
      },
    };

    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar),
    );

    expect(html).toContain('Ready Next Turn');
    expect(html).toContain('当前已修复，下条消息可用。');
    expect(html).toContain('review-skill');
  });

  it('renders an explicit managed browser section with current page preview', () => {
    composerState.browserSessionMode = 'managed';
    browserWorkbenchState.managedSession = {
      running: true,
      tabCount: 1,
      activeTab: {
        id: 'tab-1',
        url: 'https://example.com/docs',
        title: 'Docs · Example',
      },
    };
    browserWorkbenchState.preview = {
      mode: 'managed',
      url: 'https://example.com/docs',
      title: 'Docs · Example',
    };

    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar),
    );

    expect(html).toContain('Browser');
    expect(html).toContain('Managed');
    expect(html).toContain('Browser Session');
    expect(html).toContain('托管浏览器已启动');
    expect(html).toContain('Docs · Example');
    expect(html).toContain('https://example.com/docs');
  });

  it('renders desktop readiness and repair path when desktop browser context is blocked', () => {
    composerState.browserSessionMode = 'desktop';
    browserWorkbenchState.preview = {
      mode: 'desktop',
      title: 'ChatGPT',
      url: 'https://chatgpt.com',
      frontmostApp: 'Google Chrome',
      lastScreenshotAtMs: Date.now() - 120_000,
    };
    browserWorkbenchState.readinessItems = [
      {
        key: 'screenCapture',
        label: 'Screen Capture',
        ready: false,
        value: '未授权',
        detail: 'Screen Recording permission not granted.',
      },
      {
        key: 'accessibility',
        label: 'Accessibility',
        ready: false,
        value: '未授权',
        detail: 'AXIsProcessTrusted() returned false.',
      },
      {
        key: 'browserContext',
        label: 'Browser Context',
        ready: true,
        value: '支持',
        detail: '当前桌面 runtime 可以读取前台浏览器 URL / title。',
      },
      {
        key: 'collector',
        label: 'Collector',
        ready: false,
        value: '已停止',
        detail: 'collector is stopped',
      },
    ];
    browserWorkbenchState.blocked = true;
    browserWorkbenchState.blockedDetail = '当前桌面浏览器上下文未就绪：屏幕录制未授权、辅助功能未授权、collector 未启动。';
    browserWorkbenchState.blockedHint = '先补权限并启动采集；修好后这条消息再发出去，会比黑箱失败可控得多。';
    browserWorkbenchState.repairActions = [
      { kind: 'open_screen_capture_settings', label: '授权屏幕录制' },
      { kind: 'open_accessibility_settings', label: '授权辅助功能' },
      { kind: 'start_desktop_collector', label: '启动采集' },
    ];

    const html = renderToStaticMarkup(
      React.createElement(InlineWorkbenchBar),
    );

    expect(html).toContain('Desktop Readiness');
    expect(html).toContain('Screen Capture');
    expect(html).toContain('Accessibility');
    expect(html).toContain('Browser Context');
    expect(html).toContain('Collector');
    expect(html).toContain('Google Chrome');
    expect(html).toContain('授权屏幕录制');
    expect(html).toContain('授权辅助功能');
    expect(html).toContain('启动采集');
  });
});

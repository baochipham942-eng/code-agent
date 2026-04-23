import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectorStatuses = [
  {
    id: 'mail',
    label: 'Mail',
    connected: true,
    detail: 'ready',
    capabilities: ['get_status', 'list_messages'],
  },
];

const appState = {
  openSettingsTab: vi.fn(),
};

const sessionState = {
  messages: [],
};

const quickActionRunnerState = {
  runningActionKey: null as string | null,
  actionErrors: {} as Record<string, string>,
  completedActions: {} as Record<string, { kind: string; completedAt: number }>,
  runQuickAction: vi.fn(),
};

const workbenchInsightsState = {
  references: [] as unknown[],
  history: [] as unknown[],
  connectorHistory: [
    {
      kind: 'connector',
      id: 'mail',
      label: 'Mail',
      count: 2,
      lastUsed: 200,
      topActions: [
        { label: 'send', count: 1 },
        { label: 'draft', count: 1 },
      ],
    },
  ],
  mcpHistory: [] as unknown[],
  skillHistory: [
    {
      kind: 'skill',
      id: 'review-skill',
      label: 'review-skill',
      count: 1,
      lastUsed: 100,
      topActions: [{ label: 'review-skill', count: 1 }],
    },
  ],
};

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      taskPanel: {
        connectors: '连接器',
        status: '状态',
        toolCount: '工具数',
        noConnectors: '未配置连接器',
        viewAllConnectors: '查看所有连接器',
        tools: '工具',
        sessionCalls: '本次调用',
        more: '更多',
      },
    },
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchInsights', () => ({
  useWorkbenchInsights: () => workbenchInsightsState,
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({
    items: [],
    skills: [],
    connectors: connectorStatuses.map((connector) => ({
      kind: 'connector',
      key: `connector:${connector.id}`,
      ...connector,
      selected: false,
      available: connector.connected,
      blocked: false,
      visibleInWorkbench: true,
      health: connector.connected ? 'healthy' : 'inactive',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: connector.connected ? 'connected' : 'disconnected',
      },
    })),
    mcpServers: [
      {
        kind: 'mcp',
        key: 'mcp:github',
        id: 'github',
        label: 'github',
        selected: false,
        status: 'connected',
        enabled: true,
        transport: 'stdio',
        toolCount: 12,
        resourceCount: 3,
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
    ],
  }),
}));

vi.mock('../../../src/renderer/stores/appStore', () => ({
  useAppStore: (selector?: (state: any) => unknown) => (selector ? selector(appState) : appState),
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: any) => unknown) => selector(sessionState),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner', () => ({
  useWorkbenchCapabilityQuickActionRunner: () => quickActionRunnerState,
}));

import { ConnectorsCard } from '../../../src/renderer/components/TaskPanel/ConnectorsCard';

describe('TaskPanel ConnectorsCard', () => {
  beforeEach(() => {
    sessionState.messages = [];
  });

  it('renders activated connectors, mcp servers and session call history', () => {
    const html = renderToStaticMarkup(React.createElement(ConnectorsCard));

    expect(html).toContain('CONNECTORS');
    expect(html).toContain('Local');
    expect(html).toContain('Mail');
    expect(html).toContain('connected');
    expect(html).toContain('MCP');
    expect(html).toContain('github');
    expect(html).toContain('本次调用');
    expect(html).toContain('send');
    expect(html).toContain('draft');
    expect(html).toContain('review-skill');
  });
});

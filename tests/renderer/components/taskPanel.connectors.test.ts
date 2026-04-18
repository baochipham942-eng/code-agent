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

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/hooks/useWorkbenchCapabilities')>();
  return {
    ...actual,
    useWorkbenchCapabilities: () => ({
      skills: [],
      connectors: connectorStatuses.map((connector) => ({
        kind: 'connector',
        ...connector,
        selected: false,
      })),
      mcpServers: [
        {
          kind: 'mcp',
          id: 'github',
          label: 'github',
          selected: false,
          status: 'connected',
          enabled: true,
          transport: 'stdio',
          toolCount: 12,
          resourceCount: 3,
        },
      ],
    }),
  };
});

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

import { Connectors } from '../../../src/renderer/components/TaskPanel/Connectors';

describe('TaskPanel Connectors', () => {
  beforeEach(() => {
    sessionState.messages = [
      {
        timestamp: 100,
        toolCalls: [
          {
            id: '1',
            name: 'mail_send',
            arguments: {},
          },
          {
            id: '2',
            name: 'mcp__github__search_code',
            arguments: {},
          },
          {
            id: '3',
            name: 'skill',
            arguments: { command: 'review-skill' },
          },
        ],
      },
      {
        timestamp: 200,
        toolCalls: [
          {
            id: '4',
            name: 'mail_draft',
            arguments: {},
          },
        ],
      },
    ];
  });

  it('renders shared capability status and unified workbench history', () => {
    const html = renderToStaticMarkup(
      React.createElement(Connectors),
    );

    expect(html).toContain('Local');
    expect(html).toContain('Mail');
    expect(html).toContain('connected');
    expect(html).toContain('MCP');
    expect(html).toContain('github');
    expect(html).toContain('本次调用');
    expect(html).toContain('Connectors');
    expect(html).toContain('send');
    expect(html).toContain('draft');
    expect(html).toContain('review-skill');
    expect(html).toContain('查看 Mail 详情');
    expect(html).toContain('查看 github 详情');
  });
});

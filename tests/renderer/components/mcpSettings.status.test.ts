import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchMcpRegistryItem } from '../../../src/renderer/utils/workbenchCapabilityRegistry';

const invalidTokenError = [
  'Streamable HTTP error: Error POSTing to endpoint:',
  '{"error":"invalid_token","error_description":"Authentication failed. The provided bearer token is invalid, expired, or no longer recognized by the server."}',
].join(' ');

const connectedGithubServer: WorkbenchMcpRegistryItem = {
  kind: 'mcp' as const,
  key: 'mcp:github',
  id: 'github',
  label: 'github',
  selected: false,
  status: 'connected' as const,
  enabled: true,
  transport: 'stdio',
  toolCount: 12,
  resourceCount: 3,
  available: true,
  blocked: false,
  visibleInWorkbench: true,
  health: 'healthy' as const,
  lifecycle: {
    installState: 'not_applicable' as const,
    mountState: 'not_applicable' as const,
    connectionState: 'connected' as const,
  },
};

let mcpServers: WorkbenchMcpRegistryItem[] = [
  connectedGithubServer,
];

const authErrorTavilyServer: WorkbenchMcpRegistryItem = {
  kind: 'mcp' as const,
  key: 'mcp:tavily',
  id: 'tavily',
  label: 'tavily',
  selected: false,
  status: 'error' as const,
  enabled: true,
  transport: 'stdio',
  toolCount: 0,
  resourceCount: 0,
  error: invalidTokenError,
  available: false,
  blocked: false,
  visibleInWorkbench: true,
  health: 'error' as const,
  lifecycle: {
    installState: 'not_applicable' as const,
    mountState: 'not_applicable' as const,
    connectionState: 'error' as const,
  },
};

const disconnectedSlackServer: WorkbenchMcpRegistryItem = {
  kind: 'mcp' as const,
  key: 'mcp:slack',
  id: 'slack',
  label: 'slack',
  selected: false,
  status: 'disconnected' as const,
  enabled: true,
  transport: 'stdio',
  toolCount: 0,
  resourceCount: 0,
  available: false,
  blocked: false,
  visibleInWorkbench: true,
  health: 'inactive' as const,
  lifecycle: {
    installState: 'not_applicable' as const,
    mountState: 'not_applicable' as const,
    connectionState: 'disconnected' as const,
  },
};

const serverStates = [
  {
    config: {
      name: 'github',
      type: 'stdio',
      enabled: true,
    },
    status: 'connected',
    toolCount: 12,
    resourceCount: 3,
  },
];

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {},
  }),
}));

vi.mock('../../../src/renderer/hooks/useMcpStatus', () => ({
  useMcpStatus: () => ({
    status: {
      connectedServers: ['github'],
      toolCount: 12,
      resourceCount: 3,
    },
    serverStates,
    isLoading: false,
    reload: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityRegistry', () => ({
  useWorkbenchCapabilityRegistry: () => ({
    items: mcpServers,
    skills: [],
    connectors: [],
    mcpServers,
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchInsights', () => ({
  useWorkbenchInsights: () => ({
    capabilities: {
      skills: [],
      connectors: [],
      mcpServers: [],
    },
    invocationSummary: {
      skills: {},
      connectors: {},
      mcpServers: {},
    },
    references: [],
    history: [
      {
        kind: 'mcp',
        id: 'github',
        label: 'github',
        count: 2,
        lastUsed: 100,
        topActions: [{ label: 'search_code', count: 2 }],
      },
    ],
    connectorHistory: [],
    mcpHistory: [],
    skillHistory: [],
  }),
}));

vi.mock('../../../src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner', () => ({
  useWorkbenchCapabilityQuickActionRunner: () => ({
    runningActionKey: null,
    actionErrors: {},
    completedActions: {},
    runQuickAction: vi.fn(),
  }),
}));

vi.mock('../../../src/renderer/stores/authStore', () => ({
  useAuthStore: (selector: (state: { user: { isAdmin: boolean } }) => unknown) => selector({
    user: { isAdmin: true },
  }),
}));

vi.mock('../../../src/renderer/utils/platform', () => ({
  isWebMode: () => false,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn().mockResolvedValue({ codex: {} }),
  },
}));

vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

vi.mock('../../../src/renderer/components/features/settings/sections/localBridge', () => ({
  LocalBridgeSection: () => React.createElement('div', null, 'LocalBridge'),
}));

vi.mock('../../../src/renderer/components/features/settings/McpServerEditor', () => ({
  McpServerEditor: () => null,
}));

import { MCPSettings } from '../../../src/renderer/components/features/settings/tabs/MCPSettings';

describe('MCPSettings status', () => {
  beforeEach(() => {
    mcpServers = [connectedGithubServer];
  });

  it('renders overall MCP status and server list from the shared MCP hook', () => {
    const html = renderToStaticMarkup(
      React.createElement(MCPSettings),
    );

    expect(html).toContain('总览');
    expect(html).toContain('github');
    expect(html).toContain('12 工具');
    expect(html).toContain('3 资源');
    expect(html).toContain('查看 github 详情');
  });

  it('shows reauthorization instead of reconnect for invalid MCP bearer tokens', () => {
    mcpServers = [authErrorTavilyServer];

    const html = renderToStaticMarkup(
      React.createElement(MCPSettings),
    );

    expect(html).toContain('重新授权');
    expect(html).toContain('禁用');
    expect(html).toContain('禁用 MCP 后内置搜索仍可用');
    expect(html).not.toContain('重连');
  });

  it('keeps reconnect for non-auth MCP disconnections', () => {
    mcpServers = [disconnectedSlackServer];

    const html = renderToStaticMarkup(
      React.createElement(MCPSettings),
    );

    expect(html).toContain('重连');
    expect(html).not.toContain('重新授权');
  });
});

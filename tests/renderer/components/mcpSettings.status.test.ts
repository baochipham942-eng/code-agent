// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchMcpRegistryItem } from '../../../src/renderer/utils/workbenchCapabilityRegistry';
import { zh } from '../../../src/renderer/i18n/zh';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

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
let authIsAdmin = true;

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

const oauthNotionServer: WorkbenchMcpRegistryItem = {
  kind: 'mcp' as const,
  key: 'mcp:notion',
  id: 'notion',
  label: 'notion',
  selected: false,
  status: 'connected' as const,
  enabled: true,
  transport: 'http-streamable',
  toolCount: 2,
  resourceCount: 1,
  authMode: 'oauth',
  hasOAuthTokens: true,
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

const mockDomainInvoke = vi.fn();

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

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return {
    useI18n: () => ({
      t: zh,
      language: 'zh',
    }),
  };
});

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
    user: { isAdmin: authIsAdmin },
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

import { MCPSettings, getMcpTrustSummary } from '../../../src/renderer/components/features/settings/tabs/MCPSettings';

describe('MCPSettings status', () => {
  const mcpText = zh.settings.mcp;

  beforeEach(() => {
    mcpServers = [connectedGithubServer];
    authIsAdmin = true;
    mockDomainInvoke.mockResolvedValue({ success: true, data: { success: true } });
    (window as unknown as { domainAPI?: { invoke: typeof mockDomainInvoke } }).domainAPI = {
      invoke: mockDomainInvoke,
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { domainAPI?: unknown }).domainAPI;
    mockDomainInvoke.mockReset();
  });

  it('renders overall MCP status and server list from the shared MCP hook', () => {
    const html = renderToStaticMarkup(
      React.createElement(MCPSettings),
    );

    expect(html).toContain(mcpText.management.stats.overview.label);
    expect(html).toContain('github');
    expect(html).toContain(`12${mcpText.management.countToolSuffix}`);
    expect(html).toContain(`3${mcpText.management.countResourceSuffix}`);
    expect(html).toContain(mcpText.trustSummary.approvalNotice);
    expect(html).toContain('查看 github 详情');
  });

  it('summarizes MCP trust boundaries without exposing token values', () => {
    expect(getMcpTrustSummary(connectedGithubServer)).toContain(mcpText.trustSummary.authMaskedHint);
    expect(getMcpTrustSummary(authErrorTavilyServer)).toContain(mcpText.trustSummary.authReauthorizeHint);
  });

  it('shows reauthorization instead of reconnect for invalid MCP bearer tokens', () => {
    mcpServers = [authErrorTavilyServer];

    const html = renderToStaticMarkup(
      React.createElement(MCPSettings),
    );

    expect(html).toContain(mcpText.management.reauthorize);
    expect(html).toContain(mcpText.management.disable);
    expect(html).toContain('禁用 MCP 后内置搜索仍可用');
    expect(html).not.toContain(mcpText.management.reconnect);
  });

  it('keeps reconnect for non-auth MCP disconnections', () => {
    mcpServers = [disconnectedSlackServer];

    const html = renderToStaticMarkup(
      React.createElement(MCPSettings),
    );

    expect(html).toContain(mcpText.management.reconnect);
    expect(html).not.toContain(mcpText.management.reauthorize);
  });

  it('shows OAuth authorization status and sign-out only for OAuth servers', () => {
    mcpServers = [oauthNotionServer, connectedGithubServer];

    const html = renderToStaticMarkup(
      React.createElement(MCPSettings),
    );

    expect(html).toContain(mcpText.management.oauthStatusLabel);
    expect(html).toContain(mcpText.management.oauthAuthorized);
    expect(html).toContain(mcpText.management.signOut);
    expect((html.match(new RegExp(mcpText.management.signOut, 'g')) || []).length).toBe(1);
  });

  it('invokes signOutServer for OAuth server rows', async () => {
    mcpServers = [oauthNotionServer];

    render(React.createElement(MCPSettings));
    fireEvent.click(screen.getByText(mcpText.management.signOut));

    await waitFor(() => {
      expect(mockDomainInvoke).toHaveBeenCalledWith(
        IPC_DOMAINS.MCP,
        'signOutServer',
        { serverName: 'notion' },
      );
    });
  });

  it('lets non-admin users manage MCP servers while hiding bridge diagnostics', () => {
    authIsAdmin = false;

    const html = renderToStaticMarkup(
      React.createElement(MCPSettings),
    );

    expect(html).toContain(mcpText.management.refreshFromCloud);
    expect(html).toContain(mcpText.management.addServer);
    expect(html).toContain(mcpText.management.disable);
    expect(html).not.toContain('LocalBridge');
  });
});

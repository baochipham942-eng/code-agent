// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchMcpRegistryItem } from '../../../src/renderer/utils/workbenchCapabilityRegistry';
import { getWorkbenchCapabilityQuickActions } from '../../../src/renderer/utils/workbenchQuickActions';
import { zh } from '../../../src/renderer/i18n/zh';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

const { mockRunQuickAction } = vi.hoisted(() => ({
  mockRunQuickAction: vi.fn(),
}));

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
  turnReadiness: 'ready' as const,
  autoAllowed: true,
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
  turnReadiness: 'needs_config' as const,
  autoAllowed: false,
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
  turnReadiness: 'needs_config' as const,
  autoAllowed: false,
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
  turnReadiness: 'ready' as const,
  autoAllowed: true,
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
    runQuickAction: mockRunQuickAction,
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
  McpServerEditor: (props: {
    isOpen: boolean;
    initialConfig?: { name?: string };
    onSave: (
      config: { name: string; type: 'stdio'; command: string },
      secrets?: { secretEnvKeys: string[]; secretHeaderKeys: string[] },
    ) => void;
  }) => props.isOpen
    ? React.createElement(
      'div',
      null,
      React.createElement('span', null, `mock-editor-initial-${props.initialConfig?.name ?? 'none'}`),
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => props.onSave(
            { name: 'secret-server', type: 'stdio', command: 'node' },
            { secretEnvKeys: ['X'], secretHeaderKeys: [] },
          ),
        },
        'mock-save-secret-server',
      ),
    )
    : null,
}));

vi.mock('../../../src/renderer/components/features/settings/tabs/McpDiscoverTab', () => ({
  McpDiscoverTab: (props: {
    onAdd: (entry: {
      id: string;
      name: string;
      description: string;
      category: string;
      builtin: boolean;
      connection: { type: 'stdio'; command: string };
    }) => void;
  }) => React.createElement(
    'button',
    {
      type: 'button',
      onClick: () => props.onAdd({
        id: 'quick-server',
        name: 'Quick Server',
        description: 'Quick server fixture',
        category: 'dev-tools',
        builtin: false,
        connection: { type: 'stdio', command: 'npx' },
      }),
    },
    'mock-add-entry',
  ),
}));

import { MCPSettings, getMcpTrustSummary } from '../../../src/renderer/components/features/settings/tabs/MCPSettings';

describe('MCPSettings status', () => {
  const mcpText = zh.settings.mcp;

  // 默认落「发现连接」；需要「已连接」表格内容的用例先切过去。
  // tab 文案是「已连接 (N)」，用 startsWith 匹配避免硬编码计数。
  const openConnectedTab = () => {
    fireEvent.click(screen.getByText((content) => content.startsWith(mcpText.tabs.connectedPrefix)));
  };

  beforeEach(() => {
    mcpServers = [connectedGithubServer];
    authIsAdmin = true;
    mockDomainInvoke.mockResolvedValue({ success: true, data: { success: true } });
    mockRunQuickAction.mockReset();
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
    render(React.createElement(MCPSettings));
    openConnectedTab();
    const html = document.body.innerHTML;

    expect(html).toContain(mcpText.management.stats.overview.label);
    expect(html).toContain('github');
    expect(html).toContain(`12${mcpText.management.countToolSuffix}`);
    expect(html).toContain(`3${mcpText.management.countResourceSuffix}`);
    expect(html).toContain(mcpText.trustSummary.approvalNotice);
    expect(html).toContain('查看 github 详情');
    expect(html).not.toContain('Alma');
  });

  it('summarizes MCP trust boundaries without exposing token values', () => {
    expect(getMcpTrustSummary(connectedGithubServer)).toContain(mcpText.trustSummary.authMaskedHint);
    expect(getMcpTrustSummary(authErrorTavilyServer)).toContain(mcpText.trustSummary.authReauthorizeHint);
  });

  it('trust summary 对空值字段做省略，绝不拼出裸 undefined', () => {
    const unknownTransportServer = {
      ...disconnectedSlackServer,
      transport: undefined,
    } as unknown as WorkbenchMcpRegistryItem;

    const summary = getMcpTrustSummary(unknownTransportServer);
    expect(summary).not.toContain('undefined');
    expect(summary).not.toContain('null');
    // 未连接时不存在计数，摘要里也不该有计数段
    expect(summary).not.toContain(mcpText.trustSummary.toolUnit);
  });

  it('transport 未知的服务器行内不出现裸 undefined 文案', () => {
    const unknownTransportServer = {
      ...connectedGithubServer,
      transport: undefined,
    } as unknown as WorkbenchMcpRegistryItem;
    mcpServers = [unknownTransportServer];

    render(React.createElement(MCPSettings));
    openConnectedTab();

    expect(document.body.innerHTML).not.toContain('undefined');
  });

  it('moves reauthorization into the detail sheet for invalid MCP bearer tokens', () => {
    mcpServers = [authErrorTavilyServer];

    render(React.createElement(MCPSettings));
    openConnectedTab();
    const html = document.body.innerHTML;

    // 行尾只剩开关 + 详情：重连/重新授权不再铺在行上
    expect(html).not.toContain(mcpText.management.reconnect);
    expect(html).not.toContain(`>${mcpText.management.reauthorize}<`);
    expect(html).toContain('禁用 MCP 后内置搜索仍可用');

    const sheetActions = getWorkbenchCapabilityQuickActions(authErrorTavilyServer, {
      includeUnselected: true,
    });
    expect(sheetActions).toEqual([
      { kind: 'open_mcp_settings', label: '重新授权', emphasis: 'primary' },
    ]);
  });

  it('hides counts and moves reconnect into the detail sheet for non-auth disconnections', () => {
    mcpServers = [disconnectedSlackServer];

    render(React.createElement(MCPSettings));
    openConnectedTab();
    const html = document.body.innerHTML;

    // 未加载过就不存在计数：不显示误导性的「0 工具 / 0 资源」
    expect(html).not.toContain(`0${mcpText.management.countToolSuffix}`);
    expect(html).not.toContain(`0${mcpText.management.countResourceSuffix}`);
    expect(html).not.toContain(mcpText.management.reconnect);
    expect(html).not.toContain(mcpText.management.reauthorize);

    const sheetActions = getWorkbenchCapabilityQuickActions(disconnectedSlackServer, {
      includeUnselected: true,
    });
    expect(sheetActions.map((action) => action.kind)).toEqual(['retry_mcp', 'open_mcp_settings']);
  });

  it('安保样板文案全页只出现一次（页面级说明），不逐行重复', () => {
    mcpServers = [connectedGithubServer, disconnectedSlackServer, oauthNotionServer];

    render(React.createElement(MCPSettings));
    openConnectedTab();
    const html = document.body.innerHTML;

    expect(html.split(mcpText.trustSummary.approvalNotice).length - 1).toBe(1);
    expect(html.split(mcpText.trustSummary.authMaskedHint).length - 1).toBe(1);
  });

  it('行尾统一为开关 + 详情入口；开关调用 setServerEnabled', async () => {
    mcpServers = [disconnectedSlackServer];

    render(React.createElement(MCPSettings));
    openConnectedTab();
    // slack fixture 当前 enabled=true，拨动开关即禁用
    fireEvent.click(screen.getByRole('switch', {
      name: `${mcpText.management.disable} slack`,
    }));

    await waitFor(() => {
      expect(mockDomainInvoke).toHaveBeenCalledWith(
        IPC_DOMAINS.MCP,
        'setServerEnabled',
        { serverName: 'slack', enabled: false },
      );
    });
  });

  it('默认落「发现连接」；切到「已连接」后列表行头部状态点绿=connected、灰=其他态', () => {
    mcpServers = [connectedGithubServer, disconnectedSlackServer];

    render(React.createElement(MCPSettings));

    // 默认发现视角：已连接表格不渲染，发现目录（mock）在屏
    expect(screen.getByText('mock-add-entry')).toBeTruthy();
    expect(screen.queryByTestId('mcp-server-status-dot-github')).toBeNull();

    openConnectedTab();

    const githubDot = screen.getByTestId('mcp-server-status-dot-github');
    const slackDot = screen.getByTestId('mcp-server-status-dot-slack');
    expect(githubDot.className).toContain('bg-mark-success');
    expect(slackDot.className).toContain('bg-zinc-600');
  });

  it('shows OAuth authorization status only for OAuth servers; sign-out lives in the detail sheet', () => {
    mcpServers = [oauthNotionServer, connectedGithubServer];

    render(React.createElement(MCPSettings));
    openConnectedTab();
    const html = document.body.innerHTML;

    expect(html).toContain(mcpText.management.oauthStatusLabel);
    expect(html).toContain(mcpText.management.oauthAuthorized);
    // 退出授权从行上收纳进详情弹层
    expect(html).not.toContain(mcpText.management.signOut);

    const sheetActions = getWorkbenchCapabilityQuickActions(oauthNotionServer, {
      includeUnselected: true,
    });
    expect(sheetActions).toEqual([
      { kind: 'sign_out_mcp', label: '退出授权', emphasis: 'secondary' },
    ]);
    expect(getWorkbenchCapabilityQuickActions(connectedGithubServer, {
      includeUnselected: true,
    })).toEqual([]);
  });

  it('routes the sheet sign-out action through the quick-action runner', () => {
    mcpServers = [oauthNotionServer];

    render(React.createElement(MCPSettings));
    openConnectedTab();
    fireEvent.click(screen.getByLabelText('查看 notion 详情'));
    fireEvent.click(screen.getByText('退出授权'));

    expect(mockRunQuickAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'notion' }),
      expect.objectContaining({ kind: 'sign_out_mcp' }),
    );
  });

  it('passes secret keys from McpServerEditor into the addServer payload', async () => {
    render(React.createElement(MCPSettings));
    openConnectedTab();
    fireEvent.click(screen.getByText(mcpText.management.addServer));
    fireEvent.click(screen.getByText('mock-save-secret-server'));

    await waitFor(() => {
      expect(mockDomainInvoke).toHaveBeenCalledWith(
        IPC_DOMAINS.MCP,
        'addServer',
        {
          config: {
            name: 'secret-server',
            type: 'stdio',
            command: 'node',
          },
          scope: 'user',
          secretEnvKeys: ['X'],
        },
      );
    });
  });

  it('routes discover add through the prefilled editor flow', async () => {
    render(React.createElement(MCPSettings));
    fireEvent.click(screen.getByText('mock-add-entry'));

    // 「添加」不直接写库：先打开预填目录配置的编辑器
    expect(screen.getByText('mock-editor-initial-quick-server')).toBeTruthy();
    expect(mockDomainInvoke).not.toHaveBeenCalledWith(IPC_DOMAINS.MCP, 'addServer', expect.anything());

    fireEvent.click(screen.getByText('mock-save-secret-server'));

    await waitFor(() => {
      expect(mockDomainInvoke).toHaveBeenCalledWith(
        IPC_DOMAINS.MCP,
        'addServer',
        {
          config: {
            name: 'secret-server',
            type: 'stdio',
            command: 'node',
          },
          scope: 'user',
          secretEnvKeys: ['X'],
        },
      );
    });
  });

  it('lets non-admin users manage MCP servers while hiding bridge diagnostics', () => {
    authIsAdmin = false;

    render(React.createElement(MCPSettings));
    openConnectedTab();
    const html = document.body.innerHTML;

    expect(html).toContain(mcpText.management.refreshFromCloud);
    expect(html).toContain(mcpText.management.addServer);
    expect(html).toContain(mcpText.management.disable);
    expect(html).not.toContain('LocalBridge');
  });
});

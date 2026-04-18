import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mcpServers = [
  {
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
    serverStates: [
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
    ],
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
});

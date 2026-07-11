import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerCloudConfig } from '../../../src/host/services/cloud/cloudConfigService';
import type { MCPClient, MCPServerConfig, MCPServerState } from '../../../src/host/mcp/mcpClient';
import {
  convertCloudConfigToInternal,
  initMCPClient,
  refreshMCPServersFromCloud,
} from '../../../src/host/mcp/mcpDefaultServers';

const testState = vi.hoisted(() => ({
  cloudConfigService: {} as {
    getMCPServers: ReturnType<typeof vi.fn>;
    isCloudMCPServersEnabledByPolicy: ReturnType<typeof vi.fn>;
    getCloudMCPServerPolicyBlockReason: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
  },
  loadMcpConfigFiles: vi.fn(),
}));

vi.mock('../../../src/host/services/cloud/cloudConfigService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/cloud/cloudConfigService')>()),
  getCloudConfigService: () => testState.cloudConfigService,
}));

vi.mock('../../../src/host/mcp/mcpConfigFile', () => ({
  loadMcpConfigFiles: testState.loadMcpConfigFiles,
}));

vi.mock('../../../src/host/mcp/servers/memoryKVServer', () => ({
  createMemoryKVServer: () => ({ name: 'memory-kv' }),
}));

vi.mock('../../../src/host/mcp/servers/codeIndexServer', () => ({
  createCodeIndexServer: () => ({ name: 'code-index' }),
}));

function cloudServer(overrides: Partial<MCPServerCloudConfig> = {}): MCPServerCloudConfig {
  return {
    id: 'cloud-search',
    name: 'Cloud Search',
    type: 'http-streamable',
    enabled: true,
    config: {
      url: 'https://cloud.example.com/mcp',
    },
    ...overrides,
  };
}

function localServer(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: 'local-search',
    type: 'http-streamable',
    serverUrl: 'http://127.0.0.1:8787/mcp',
    enabled: true,
    scope: 'local',
    ...overrides,
  } as MCPServerConfig;
}

function serverState(config: MCPServerConfig): MCPServerState {
  return {
    config,
    status: 'disconnected',
    toolCount: 0,
    resourceCount: 0,
  };
}

function createFakeClient(initialStates: MCPServerState[] = []) {
  const added: MCPServerConfig[] = [];
  const states = new Map(initialStates.map((state) => [state.config.name, state]));
  const client = {
    added,
    addServer: vi.fn((config: MCPServerConfig) => {
      added.push(config);
      states.set(config.name, serverState(config));
    }),
    registerInProcessServer: vi.fn(),
    connectAll: vi.fn(),
    getServerStates: vi.fn(() => Array.from(states.values())),
    getServerState: vi.fn((name: string) => states.get(name)),
    removeServer: vi.fn(async (name: string) => {
      states.delete(name);
    }),
    updateServerConfig: vi.fn(async (name: string, config: MCPServerConfig) => {
      states.set(name, serverState(config));
    }),
    connect: vi.fn(),
  };
  return client as unknown as MCPClient & typeof client;
}

describe('mcpDefaultServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.cloudConfigService = {
      getMCPServers: vi.fn(() => []),
      isCloudMCPServersEnabledByPolicy: vi.fn(() => true),
      getCloudMCPServerPolicyBlockReason: vi.fn(() => null),
      refresh: vi.fn(async () => ({ success: true, version: 'test' })),
    };
    testState.loadMcpConfigFiles.mockResolvedValue([]);
  });

  it('rewrites deprecated DeepWiki SSE cloud config to streamable HTTP', () => {
    const result = convertCloudConfigToInternal({
      id: 'deepwiki',
      name: 'DeepWiki',
      type: 'sse',
      enabled: true,
      config: {
        url: 'https://mcp.deepwiki.com/sse',
      },
    } satisfies MCPServerCloudConfig);

    expect(result).toMatchObject({
      name: 'deepwiki',
      type: 'http-streamable',
      serverUrl: 'https://mcp.deepwiki.com/mcp',
      enabled: true,
    });
  });

  it('normalizes legacy Tavily x-api-key cloud config to Bearer auth', () => {
    vi.stubEnv('TEST_TAVILY_KEY', 'tvly-test-key');

    const result = convertCloudConfigToInternal({
      id: 'tavily',
      name: 'Tavily Search',
      type: 'http-streamable',
      enabled: true,
      config: {
        url: 'https://mcp.tavily.com/mcp/',
        headers: {
          'x-api-key': '${TEST_TAVILY_KEY}',
        },
      },
      requiredEnvVars: ['TEST_TAVILY_KEY'],
    } satisfies MCPServerCloudConfig);

    expect(result).toMatchObject({
      name: 'tavily',
      type: 'http-streamable',
      headers: {
        Authorization: 'Bearer tvly-test-key',
      },
      enabled: true,
    });
    expect((result as { headers?: Record<string, string> }).headers).not.toHaveProperty('x-api-key');
  });

  it('normalizes legacy Exa endpoint to request the supported search tools', () => {
    const result = convertCloudConfigToInternal({
      id: 'exa',
      name: 'Exa AI Search',
      type: 'http-streamable',
      enabled: true,
      config: {
        url: 'https://mcp.exa.ai/mcp',
      },
    } satisfies MCPServerCloudConfig);

    expect(result).toMatchObject({
      name: 'exa',
      type: 'http-streamable',
      serverUrl: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa',
      enabled: true,
    });
  });

  it('blocks cloud MCP servers during init when policy denies them while preserving local MCP config', async () => {
    testState.cloudConfigService.getMCPServers.mockReturnValue([cloudServer()]);
    testState.cloudConfigService.isCloudMCPServersEnabledByPolicy.mockReturnValue(false);
    testState.cloudConfigService.getCloudMCPServerPolicyBlockReason.mockReturnValue('global_kill_switch');
    testState.loadMcpConfigFiles.mockResolvedValue([localServer()]);
    const client = createFakeClient();

    await initMCPClient(() => client, undefined, '/tmp/project');

    expect(client.added.map((config) => config.name)).toEqual(['local-search']);
    expect(client.added[0]?.scope).toBe('local');
    expect(client.connectAll).toHaveBeenCalledTimes(1);
  });

  it('adds cloud MCP servers during init when policy allows them', async () => {
    testState.cloudConfigService.getMCPServers.mockReturnValue([cloudServer()]);
    testState.cloudConfigService.isCloudMCPServersEnabledByPolicy.mockReturnValue(true);
    const client = createFakeClient();

    await initMCPClient(() => client);

    expect(client.added).toEqual([
      expect.objectContaining({
        name: 'cloud-search',
        type: 'http-streamable',
        serverUrl: 'https://cloud.example.com/mcp',
        enabled: true,
        scope: 'cloud',
      }),
    ]);
    expect(client.connectAll).toHaveBeenCalledTimes(1);
  });

  it('removes only existing cloud MCP servers during blocked refresh and leaves local MCP config untouched', async () => {
    testState.cloudConfigService.getMCPServers.mockReturnValue([cloudServer()]);
    testState.cloudConfigService.isCloudMCPServersEnabledByPolicy.mockReturnValue(false);
    testState.cloudConfigService.getCloudMCPServerPolicyBlockReason.mockReturnValue('entitlement_revoked');
    const client = createFakeClient([
      serverState(localServer()),
      serverState(localServer({
        name: 'cloud-search',
        scope: 'cloud',
      })),
    ]);

    await refreshMCPServersFromCloud(() => client);

    expect(client.removeServer).toHaveBeenCalledWith('cloud-search');
    expect(client.removeServer).not.toHaveBeenCalledWith('local-search');
    expect(client.addServer).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('does not let refreshed cloud MCP config override a non-cloud server with the same name', async () => {
    testState.cloudConfigService.getMCPServers.mockReturnValue([cloudServer()]);
    testState.cloudConfigService.isCloudMCPServersEnabledByPolicy.mockReturnValue(true);
    const client = createFakeClient([
      serverState(localServer({
        name: 'cloud-search',
        scope: 'local',
      })),
    ]);

    await refreshMCPServersFromCloud(() => client);

    expect(client.addServer).not.toHaveBeenCalled();
    expect(client.updateServerConfig).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.getServerState('cloud-search')?.config.scope).toBe('local');
  });
});

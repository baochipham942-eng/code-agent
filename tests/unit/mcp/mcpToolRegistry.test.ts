import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../../src/main/mcp/mcpClient';
import { MCPToolRegistry } from '../../../src/main/mcp/mcpToolRegistry';
import { getToolSearchService, resetToolSearchService } from '../../../src/main/services/toolSearch';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  logger: {
    debug: loggerMocks.debug,
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: loggerMocks.error,
  },
  createLogger: () => loggerMocks,
}));

describe('MCPToolRegistry.parseMCPToolName', () => {
  it('parses Claude-compatible double-underscore MCP tool names', () => {
    const registry = new MCPToolRegistry();

    expect(registry.parseMCPToolName('mcp__github__search_code')).toEqual({
      serverName: 'github',
      toolName: 'search_code',
    });
  });

  it('keeps underscores inside the tool name', () => {
    const registry = new MCPToolRegistry();

    expect(registry.parseMCPToolName('mcp__linear__issue_create_with_template')).toEqual({
      serverName: 'linear',
      toolName: 'issue_create_with_template',
    });
  });

  it('rejects malformed double-underscore names', () => {
    const registry = new MCPToolRegistry();

    expect(registry.parseMCPToolName('mcp__github')).toBeNull();
    expect(registry.parseMCPToolName('mcp____search')).toBeNull();
    expect(registry.parseMCPToolName('mcp__github__')).toBeNull();
  });

  it('keeps legacy single-underscore parsing for old callers', () => {
    const registry = new MCPToolRegistry();

    expect(registry.parseMCPToolName('mcp_github_search_code')).toEqual({
      serverName: 'github',
      toolName: 'search_code',
    });
  });
});

describe('MCPToolRegistry permission metadata', () => {
  it('maps read-only and destructive MCP annotations into tool permissions', () => {
    const registry = new MCPToolRegistry();
    registry.tools = [
      {
        serverName: 'docs',
        name: 'read_page',
        description: 'Read docs',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        serverName: 'github',
        name: 'delete_repo',
        description: 'Delete repo',
        inputSchema: { type: 'object', properties: {} },
        annotations: { destructiveHint: true },
      },
    ];

    const definitions = registry.getToolDefinitions();

    expect(definitions.find((definition) => definition.name === 'mcp__docs__read_page')).toMatchObject({
      requiresPermission: false,
      permissionLevel: 'read',
    });
    expect(definitions.find((definition) => definition.name === 'mcp__github__delete_repo')).toMatchObject({
      requiresPermission: true,
      permissionLevel: 'execute',
    });
  });

  it('redacts sensitive MCP arguments before logging', async () => {
    loggerMocks.info.mockClear();
    const registry = new MCPToolRegistry();
    const client = {
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      })),
    };

    await registry.callExternalTool(
      'call-1',
      'github',
      'search_code',
      {
        query: 'repo:example test',
        api_key: 'sk-live-secret',
        nested: { auth: 'fixture' },
      },
      client as never,
    );

    const firstLogMeta = loggerMocks.info.mock.calls[0]?.[1];
    expect(firstLogMeta).toMatchObject({
      args: {
        query: 'repo:example test',
        api_key: '[REDACTED]',
        nested: { auth: '[REDACTED]' },
      },
    });
    expect(JSON.stringify(firstLogMeta)).not.toContain('sk-live-secret');
    expect(JSON.stringify(firstLogMeta)).not.toContain('fixture');
  });

  it('passes timeout and abort signal to external MCP SDK calls', async () => {
    const registry = new MCPToolRegistry();
    const controller = new AbortController();
    const client = {
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      })),
    };

    await registry.callExternalTool(
      'call-1',
      'github',
      'search_code',
      { query: 'repo:example test' },
      client as never,
      { timeoutMs: 1234, abortSignal: controller.signal },
    );

    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'search_code', arguments: { query: 'repo:example test' } },
      undefined,
      { timeout: 1234, signal: controller.signal },
    );
  });

  it('returns cancelled without calling external MCP client when already aborted', async () => {
    const registry = new MCPToolRegistry();
    const controller = new AbortController();
    controller.abort();
    const client = {
      callTool: vi.fn(),
    };

    const result = await registry.callExternalTool(
      'call-1',
      'github',
      'search_code',
      { query: 'repo:example test' },
      client as never,
      { abortSignal: controller.signal },
    );

    expect(result).toMatchObject({
      toolCallId: 'call-1',
      success: false,
      error: 'cancelled',
      metadata: { cancelledByRun: true },
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });
});

describe('MCPClient lazy search discovery', () => {
  it('starts matching lazy stdio servers before ToolSearch searches MCP tools', async () => {
    resetToolSearchService();
    const client = new MCPClient();
    client.addServer({
      name: 'sequential-thinking',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      enabled: true,
    });

    const ensureConnected = vi.spyOn(client, 'ensureConnected').mockImplementation(async (serverName) => {
      getToolSearchService().registerMCPTool({
        name: `mcp__${serverName}__think`,
        shortDescription: 'Sequential thinking tool',
        tags: ['mcp', 'network'],
        aliases: ['think', 'sequential'],
        source: 'mcp',
        mcpServer: serverName,
      });
      return true;
    });

    const discovery = await client.discoverLazyServersForSearch('sequential');
    const search = await getToolSearchService().searchTools('think', { maxResults: 3 });

    expect(ensureConnected).toHaveBeenCalledWith('sequential-thinking');
    expect(discovery).toEqual([{
      serverName: 'sequential-thinking',
      connected: true,
      toolCount: 0,
    }]);
    expect(search.loadedTools).toEqual(['mcp__sequential-thinking__think']);
  });

  it('does not start unrelated lazy stdio servers for generic searches', async () => {
    resetToolSearchService();
    const client = new MCPClient();
    client.addServer({
      name: 'sequential-thinking',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      enabled: true,
    });

    const ensureConnected = vi.spyOn(client, 'ensureConnected').mockResolvedValue(true);

    const discovery = await client.discoverLazyServersForSearch('desktop activity');

    expect(discovery).toEqual([]);
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it('returns server-level discovery errors when matching lazy stdio connect fails', async () => {
    resetToolSearchService();
    const client = new MCPClient();
    client.addServer({
      name: 'sequential-thinking',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      enabled: true,
    });

    const ensureConnected = vi.spyOn(client, 'ensureConnected').mockImplementation(async (serverName) => {
      const state = client.getServerState(serverName);
      if (state) {
        state.status = 'error';
        state.error = 'spawn failed';
      }
      return false;
    });

    const discovery = await client.discoverLazyServersForSearch('sequential');

    expect(ensureConnected).toHaveBeenCalledWith('sequential-thinking');
    expect(discovery).toEqual([{
      serverName: 'sequential-thinking',
      connected: false,
      toolCount: 0,
      error: 'spawn failed',
    }]);
  });

  it('retries matching lazy stdio servers from disconnected or error state during search discovery', async () => {
    resetToolSearchService();
    const client = new MCPClient();
    client.addServer({
      name: 'sequential-thinking',
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      enabled: true,
    });
    const state = client.getServerState('sequential-thinking');
    if (state) {
      state.status = 'error';
      state.error = 'previous failure';
    }

    const ensureConnected = vi.spyOn(client, 'ensureConnected').mockImplementation(async (serverName) => {
      const nextState = client.getServerState(serverName);
      if (nextState) {
        nextState.status = 'connected';
        nextState.error = undefined;
      }
      return true;
    });

    const discovery = await client.discoverLazyServersForSearch('sequential');

    expect(ensureConnected).toHaveBeenCalledWith('sequential-thinking');
    expect(discovery).toEqual([{
      serverName: 'sequential-thinking',
      connected: true,
      toolCount: 0,
    }]);
  });
});

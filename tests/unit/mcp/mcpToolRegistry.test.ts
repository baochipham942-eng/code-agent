import { describe, expect, it, vi } from 'vitest';
import {
  MCPClient,
  shouldBlockRawCuaInvocation,
  shouldSuppressCuaAutoReplay,
} from '../../../src/host/mcp/mcpClient';
import { MCPToolRegistry } from '../../../src/host/mcp/mcpToolRegistry';
import { getToolSearchService, resetToolSearchService } from '../../../src/host/services/toolSearch';
import {
  createRunTraceContext,
  withRunTraceContext,
} from '../../../src/host/telemetry/runTraceContext';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: {
    debug: loggerMocks.debug,
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: loggerMocks.error,
  },
  createLogger: () => loggerMocks,
}));

describe('MCPToolRegistry.parseMCPToolName', () => {
  it('suppresses replay only for stateful CUA mutations', () => {
    const enabled = { CODE_AGENT_ENABLE_CUA: '1', CODE_AGENT_CUA_STATE_V2: '1' };
    expect(shouldSuppressCuaAutoReplay('cua-driver', 'click', enabled)).toBe(true);
    expect(shouldSuppressCuaAutoReplay('cua-driver', 'type_text', enabled)).toBe(true);
    expect(shouldSuppressCuaAutoReplay('cua-driver', 'get_window_state', enabled)).toBe(false);
    expect(shouldSuppressCuaAutoReplay('github', 'create_issue', enabled)).toBe(false);
    expect(shouldSuppressCuaAutoReplay('cua-driver', 'click', {
      CODE_AGENT_ENABLE_CUA: '1',
    })).toBe(false);
  });

  it('requires the internal stateful facade capability for every raw CUA invocation', () => {
    const enabled = { CODE_AGENT_ENABLE_CUA: '1', CODE_AGENT_CUA_STATE_V2: '1' };
    expect(shouldBlockRawCuaInvocation('cua-driver', {}, enabled)).toBe(true);
    expect(shouldBlockRawCuaInvocation('cua-driver', { cuaStatefulFacade: true }, enabled)).toBe(false);
    expect(shouldBlockRawCuaInvocation('github', {}, enabled)).toBe(false);
    expect(shouldBlockRawCuaInvocation('cua-driver', {}, { CODE_AGENT_ENABLE_CUA: '1' })).toBe(false);
  });

  it('blocks a raw CUA call before lazy connection when the facade is enabled', async () => {
    const previousCua = process.env.CODE_AGENT_ENABLE_CUA;
    const previousV2 = process.env.CODE_AGENT_CUA_STATE_V2;
    process.env.CODE_AGENT_ENABLE_CUA = '1';
    process.env.CODE_AGENT_CUA_STATE_V2 = '1';
    try {
      const client = new MCPClient();
      const result = await client.callTool('raw-call', 'cua-driver', 'click', { pid: 1, x: 1, y: 1 });
      expect(result).toMatchObject({
        success: false,
        metadata: { cuaStateFacadeRequired: true },
      });
    } finally {
      if (previousCua === undefined) delete process.env.CODE_AGENT_ENABLE_CUA;
      else process.env.CODE_AGENT_ENABLE_CUA = previousCua;
      if (previousV2 === undefined) delete process.env.CODE_AGENT_CUA_STATE_V2;
      else process.env.CODE_AGENT_CUA_STATE_V2 = previousV2;
    }
  });

  it('invalidates the connection generation as soon as disconnect begins', async () => {
    const client = new MCPClient();
    expect(client.getServerConnectionGeneration('cua-driver')).toBeUndefined();
    await client.disconnect('cua-driver');
    expect(client.getServerConnectionGeneration('cua-driver')).toBe('cua-driver:1');
  });

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
  it('hides raw CUA tools when the stateful facade is enabled', () => {
    const previousCua = process.env.CODE_AGENT_ENABLE_CUA;
    const previousV2 = process.env.CODE_AGENT_CUA_STATE_V2;
    process.env.CODE_AGENT_ENABLE_CUA = '1';
    process.env.CODE_AGENT_CUA_STATE_V2 = '1';
    try {
      resetToolSearchService();
      const registry = new MCPToolRegistry();
      const rawClick = {
        serverName: 'cua-driver',
        name: 'click',
        description: 'raw click',
        inputSchema: { type: 'object', properties: {} },
      };
      registry.tools = [rawClick];
      registry.refreshServerTools('cua-driver', [{
        name: rawClick.name,
        description: rawClick.description,
        inputSchema: rawClick.inputSchema,
      }]);

      expect(registry.getToolDefinitions()).toEqual([]);
      expect(registry.getTools()).toHaveLength(1);
      expect(getToolSearchService().getDeferredToolsSummary()).not.toContain('mcp__cua-driver__click');
    } finally {
      resetToolSearchService();
      if (previousCua === undefined) delete process.env.CODE_AGENT_ENABLE_CUA;
      else process.env.CODE_AGENT_ENABLE_CUA = previousCua;
      if (previousV2 === undefined) delete process.env.CODE_AGENT_CUA_STATE_V2;
      else process.env.CODE_AGENT_CUA_STATE_V2 = previousV2;
    }
  });

  it('preserves CUA structuredContent and screenshot data for the internal adapter', async () => {
    const registry = new MCPToolRegistry();
    const client = {
      callTool: vi.fn(async () => ({
        isError: false,
        structuredContent: { snapshot_id: 'snapshot-1', elements: [] },
        content: [
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
          { type: 'text', text: 'window state' },
        ],
      })),
    };

    const result = await registry.callExternalTool(
      'tool-1',
      'cua-driver',
      'get_window_state',
      { pid: 1, window_id: 2 },
      client as never,
    );

    expect(result.metadata).toEqual({
      mcpStructuredContent: { snapshot_id: 'snapshot-1', elements: [] },
      cuaScreenshot: { data: 'aW1hZ2U=', mimeType: 'image/png' },
    });
  });

  it('preserves the provider rejection instead of inferring delivery from later effects', async () => {
    const registry = new MCPToolRegistry();
    const providerMessage = 'set_value failed: AXUIElementSetAttributeValue(AXValue) failed with error -25204';
    const client = {
      callTool: vi.fn(async () => ({
        isError: true,
        content: [{ type: 'text', text: providerMessage }],
      })),
    };

    const result = await registry.callExternalTool(
      'tool-rejected',
      'cua-driver',
      'set_value',
      { pid: 1, element_token: 'opaque', value: 'new' },
      client as never,
    );

    expect(client.callTool).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: false,
      output: providerMessage,
    });
  });

  it('preserves CUA observation metadata after a read-only reconnect retry', async () => {
    const registry = new MCPToolRegistry();
    const client = {
      callTool: vi.fn(async () => ({
        isError: false,
        structuredContent: { snapshot_id: 'snapshot-retry', elements: [] },
        content: [{ type: 'image', data: 'cmV0cnk=', mimeType: 'image/png' }],
      })),
    };

    const result = await registry.retryToolCall(
      'tool-retry',
      'cua-driver',
      'get_window_state',
      { pid: 1, window_id: 2 },
      client as never,
      Date.now(),
    );

    expect(result?.metadata).toEqual({
      mcpStructuredContent: { snapshot_id: 'snapshot-retry', elements: [] },
      cuaScreenshot: { data: 'cmV0cnk=', mimeType: 'image/png' },
    });
  });

  it('skips resource and prompt probes when server capabilities only declare tools', async () => {
    resetToolSearchService();
    const registry = new MCPToolRegistry();
    const client = {
      getServerCapabilities: vi.fn(() => ({ tools: {} })),
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: 'ping',
            description: 'Ping',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      })),
      listResources: vi.fn(),
      listPrompts: vi.fn(),
    };

    await registry.discoverCapabilities('codex', client as never);

    expect(client.listTools).toHaveBeenCalledOnce();
    expect(client.listResources).not.toHaveBeenCalled();
    expect(client.listPrompts).not.toHaveBeenCalled();
    expect(registry.getToolCount('codex')).toBe(1);
    expect(registry.getResourceCount('codex')).toBe(0);
    expect(registry.getPrompts().filter((prompt) => prompt.serverName === 'codex')).toHaveLength(0);
  });

  it('records server and tool task declarations without treating hints as trust', async () => {
    resetToolSearchService();
    const registry = new MCPToolRegistry();
    const client = {
      getServerCapabilities: vi.fn(() => ({
        tools: {},
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      })),
      listTools: vi.fn(async () => ({ tools: [{
        name: 'long_read', description: 'Long read', inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, idempotentHint: true },
        execution: { taskSupport: 'optional' },
      }] })),
      listResources: vi.fn(),
      listPrompts: vi.fn(),
    };

    await registry.discoverCapabilities('docs', client as never);

    expect(registry.getTaskCapabilityDeclaration('docs', 'long_read')).toEqual({
      server: { toolsCall: true, list: true, cancel: true },
      toolTaskSupport: 'optional',
    });
    expect(registry.getToolDefinitions()[0]?.metadata).toMatchObject({
      annotations: { readOnlyHint: true, idempotentHint: true },
      execution: { taskSupport: 'optional' },
    });
  });

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
      readOnly: true,
    });
    expect(definitions.find((definition) => definition.name === 'mcp__github__delete_repo')).toMatchObject({
      requiresPermission: true,
      permissionLevel: 'execute',
      readOnly: false,
    });
  });

  it('无 annotations 的 MCP 工具兜底为 network 且 readOnly=false（readOnly 探索档强制确认锚点，审出 HIGH）', () => {
    const registry = new MCPToolRegistry();
    registry.tools = [
      {
        serverName: 'github',
        name: 'create_issue',
        description: 'Create issue (server 未声明 annotations)',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        serverName: 'search',
        name: 'web_lookup',
        description: 'Read-only open-world search',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
    ];

    const definitions = registry.getToolDefinitions();

    // 未声明 annotations：不能证明只读 → readOnly 档下强制确认
    expect(definitions.find((definition) => definition.name === 'mcp__github__create_issue')).toMatchObject({
      requiresPermission: true,
      permissionLevel: 'network',
      readOnly: false,
    });
    // 显式 readOnlyHint 的开放世界工具：network 档但 readOnly=true → readOnly 档下直通
    expect(definitions.find((definition) => definition.name === 'mcp__search__web_lookup')).toMatchObject({
      requiresPermission: true,
      permissionLevel: 'network',
      readOnly: true,
    });
  });

  it('maps CUA agent cursor lifecycle tools as read-only permissions', () => {
    const registry = new MCPToolRegistry();
    registry.tools = [
      {
        serverName: 'cua-driver',
        name: 'start_session',
        description: 'Declare CUA run session',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        serverName: 'cua-driver',
        name: 'end_session',
        description: 'Clean up CUA run session',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        serverName: 'cua-driver',
        name: 'get_agent_cursor_state',
        description: 'Read agent cursor state',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        serverName: 'cua-driver',
        name: 'click',
        description: 'Click desktop target',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    const definitions = registry.getToolDefinitions();
    for (const name of [
      'mcp__cua-driver__start_session',
      'mcp__cua-driver__end_session',
      'mcp__cua-driver__get_agent_cursor_state',
    ]) {
      expect(definitions.find((definition) => definition.name === name)).toMatchObject({
        requiresPermission: false,
        permissionLevel: 'read',
      });
    }
    expect(definitions.find((definition) => definition.name === 'mcp__cua-driver__click')).toMatchObject({
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

  it('propagates W3C trace context without prompt, token, or raw arguments in metadata', async () => {
    const registry = new MCPToolRegistry();
    const client = {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false })),
    };
    const traceContext = createRunTraceContext({
      runId: 'run-mcp', sessionId: 'session-mcp', attempt: 1, ownerEpoch: 1,
      engine: 'native', workspace: '/tmp/mcp', processInstanceId: 'process-mcp',
    });

    await withRunTraceContext(traceContext, () => registry.callExternalTool(
      'call-traced', 'github', 'search_code', { query: 'secret query', apiKey: 'secret' }, client as never,
    ));

    const request = client.callTool.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request._meta).toEqual({
      traceparent: `00-${traceContext.traceId}-${traceContext.spanId}-01`,
    });
    expect(JSON.stringify(request._meta)).not.toMatch(/secret|query|apiKey/i);
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

describe('MCPToolRegistry listChanged refresh', () => {
  const sdkTool = (name: string) => ({
    name,
    description: `tool ${name}`,
    inputSchema: { type: 'object' as const, properties: {} },
  });
  const mcpNames = (server: string) =>
    getToolSearchService()
      .getDeferredToolsSummary()
      .split('\n')
      .filter((n) => n.startsWith(`mcp__${server}__`))
      .sort();

  it('replaces a server tools and removes stale ToolSearch entries on refresh', () => {
    resetToolSearchService();
    const registry = new MCPToolRegistry();

    registry.refreshServerTools('fs', [sdkTool('read'), sdkTool('write')]);
    expect(registry.getToolCount('fs')).toBe(2);
    expect(mcpNames('fs')).toEqual(['mcp__fs__read', 'mcp__fs__write']);

    // server 动态下线 write、新增 stat
    registry.refreshServerTools('fs', [sdkTool('read'), sdkTool('stat')]);
    expect(registry.getToolCount('fs')).toBe(2);
    expect(mcpNames('fs')).toEqual(['mcp__fs__read', 'mcp__fs__stat']);
  });

  it('does not touch other servers tools when refreshing one server', () => {
    resetToolSearchService();
    const registry = new MCPToolRegistry();

    registry.refreshServerTools('fs', [sdkTool('read')]);
    registry.refreshServerTools('git', [sdkTool('commit')]);
    expect(registry.getToolCount('fs')).toBe(1);
    expect(registry.getToolCount('git')).toBe(1);

    registry.refreshServerTools('fs', []);
    expect(registry.getToolCount('fs')).toBe(0);
    expect(registry.getToolCount('git')).toBe(1);
    expect(mcpNames('git')).toEqual(['mcp__git__commit']);
  });

  it('refreshes resources and prompts independently', () => {
    resetToolSearchService();
    const registry = new MCPToolRegistry();

    registry.refreshServerResources('docs', [
      { uri: 'doc://a', name: 'a' },
      { uri: 'doc://b', name: 'b' },
    ]);
    expect(registry.getResourceCount('docs')).toBe(2);

    registry.refreshServerResources('docs', [{ uri: 'doc://a', name: 'a' }]);
    expect(registry.getResourceCount('docs')).toBe(1);

    registry.refreshServerPrompts('docs', [{ name: 'summarize' }]);
    expect(registry.getPrompts().filter((p) => p.serverName === 'docs')).toHaveLength(1);
  });
});

describe('ToolSearchService.unregisterMCPServer', () => {
  it('removes only the targeted server MCP tool metadata', () => {
    resetToolSearchService();
    const svc = getToolSearchService();
    svc.registerMCPTools([
      { name: 'mcp__fs__read', shortDescription: 'r', tags: ['mcp'], aliases: [], source: 'mcp', mcpServer: 'fs' },
      { name: 'mcp__git__log', shortDescription: 'l', tags: ['mcp'], aliases: [], source: 'mcp', mcpServer: 'git' },
    ]);

    svc.unregisterMCPServer('fs');
    const remaining = svc
      .getDeferredToolsSummary()
      .split('\n')
      .filter((n) => n.startsWith('mcp__'));
    expect(remaining).toEqual(['mcp__git__log']);
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

  it('discovers lazy cua-driver for Computer Use searches without eager startup', async () => {
    resetToolSearchService();
    const client = new MCPClient();
    client.addServer({
      name: 'cua-driver',
      type: 'stdio',
      command: '/opt/agent-neo/cua-driver',
      args: ['mcp'],
      enabled: true,
      lazyLoad: true,
    });

    const ensureConnected = vi.spyOn(client, 'ensureConnected').mockImplementation(async (serverName) => {
      const state = client.getServerState(serverName);
      if (state) {
        state.status = 'connected';
        state.error = undefined;
      }
      return true;
    });

    const discovery = await client.discoverLazyServersForSearch('Computer Use desktop control');

    expect(ensureConnected).toHaveBeenCalledWith('cua-driver');
    expect(discovery).toEqual([{
      serverName: 'cua-driver',
      connected: true,
      toolCount: 0,
    }]);
  });
});

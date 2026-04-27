import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../src/main/tools/types';

const mcpDefinition = {
  name: 'mcp__github__search_code',
  description: '[MCP:github] Search code',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
  requiresPermission: true,
  permissionLevel: 'network' as const,
};

const mocks = vi.hoisted(() => ({
  getSchemas: vi.fn(() => []),
  has: vi.fn(() => false),
  resolve: vi.fn(),
  getToolDefinitions: vi.fn(),
  parseMCPToolName: vi.fn(),
  callTool: vi.fn(),
}));

vi.mock('../../../src/main/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({
    getSchemas: mocks.getSchemas,
    has: mocks.has,
    resolve: mocks.resolve,
  }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));

vi.mock('../../../src/main/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/main/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: mocks.getToolDefinitions,
    parseMCPToolName: mocks.parseMCPToolName,
    callTool: mocks.callTool,
  }),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { getToolResolver, resetToolResolver } = await import('../../../src/main/tools/dispatch/toolResolver');

function makeCtx(scope?: ToolContext['toolScope']): ToolContext {
  const controller = new AbortController();
  return {
    workingDirectory: '/tmp',
    requestPermission: async () => true,
    currentToolCallId: 'tool-call-1',
    abortSignal: controller.signal,
    toolScope: scope,
  };
}

describe('ToolResolver MCP direct tools', () => {
  beforeEach(() => {
    resetToolResolver();
    mocks.getSchemas.mockReturnValue([]);
    mocks.has.mockReturnValue(false);
    mocks.resolve.mockReset();
    mocks.getToolDefinitions.mockReturnValue([mcpDefinition]);
    mocks.parseMCPToolName.mockImplementation((name: string) => (
      name === 'mcp__github__search_code'
        ? { serverName: 'github', toolName: 'search_code' }
        : null
    ));
    mocks.callTool.mockReset();
    mocks.callTool.mockResolvedValue({
      toolCallId: 'tool-call-1',
      success: true,
      output: 'found results',
      duration: 12,
      metadata: { count: 1 },
    });
  });

  it('recognizes MCP dynamic definitions', () => {
    const resolver = getToolResolver();

    expect(resolver.getDefinition('mcp__github__search_code')).toEqual(mcpDefinition);
    expect(resolver.has('mcp__github__search_code')).toBe(true);
    expect(resolver.list()).toContain('mcp__github__search_code');
  });

  it('executes MCP dynamic tools through MCPClient.callTool', async () => {
    const resolver = getToolResolver();

    const result = await resolver.execute(
      'mcp__github__search_code',
      { query: 'repo:example test' },
      makeCtx(),
    );

    expect(mocks.callTool).toHaveBeenCalledWith(
      'tool-call-1',
      'github',
      'search_code',
      { query: 'repo:example test' },
      { abortSignal: expect.any(AbortSignal) },
    );
    expect(result).toMatchObject({
      success: true,
      output: 'found results',
      result: 'found results',
      metadata: {
        count: 1,
        serverName: 'github',
        toolName: 'search_code',
        duration: 12,
      },
    });
  });

  it('blocks MCP dynamic tools outside the workbench MCP server scope', async () => {
    const resolver = getToolResolver();

    const result = await resolver.execute(
      'mcp__github__search_code',
      { query: 'repo:example test' },
      makeCtx({ allowedMcpServerIds: ['filesystem'] }),
    );

    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('WORKBENCH_SCOPE_DENIED');
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});

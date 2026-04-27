import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { ToolExecutor } = await import('../../../src/main/tools/toolExecutor');
const { resetToolResolver } = await import('../../../src/main/tools/dispatch/toolResolver');

describe('ToolExecutor MCP dynamic direct execution', () => {
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
      toolCallId: 'call-1',
      success: true,
      output: 'ok',
      duration: 5,
    });
  });

  it('asks permission then dispatches dynamic MCP tools through MCPClient', async () => {
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({
      workingDirectory: '/tmp',
      requestPermission,
    });
    executor.setAuditEnabled(false);

    const result = await executor.execute(
      'mcp__github__search_code',
      { query: 'repo:example test' },
      { sessionId: 'sess-1', currentToolCallId: 'call-1' },
    );

    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      type: 'network',
      tool: 'mcp__github__search_code',
      details: expect.objectContaining({ query: 'repo:example test' }),
      sessionId: 'sess-1',
    }));
    expect(mocks.callTool).toHaveBeenCalledWith(
      'call-1',
      'github',
      'search_code',
      { query: 'repo:example test' },
      { abortSignal: undefined },
    );
    expect(result).toMatchObject({
      success: true,
      output: 'ok',
    });
  });

  it('passes run abort signal into dynamic MCP dispatch', async () => {
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({
      workingDirectory: '/tmp',
      requestPermission,
    });
    executor.setAuditEnabled(false);
    const controller = new AbortController();

    await executor.execute(
      'mcp__github__search_code',
      { query: 'repo:example test' },
      { sessionId: 'sess-1', currentToolCallId: 'call-1', abortSignal: controller.signal },
    );

    expect(mocks.callTool).toHaveBeenCalledWith(
      'call-1',
      'github',
      'search_code',
      { query: 'repo:example test' },
      { abortSignal: controller.signal },
    );
  });

  it('does not call MCPClient when permission is denied', async () => {
    const executor = new ToolExecutor({
      workingDirectory: '/tmp',
      requestPermission: vi.fn(async () => false),
    });
    executor.setAuditEnabled(false);

    const result = await executor.execute(
      'mcp__github__search_code',
      { query: 'repo:example test' },
      { sessionId: 'sess-1', currentToolCallId: 'call-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Permission denied by user');
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it('validates dynamic MCP required fields before permission and dispatch', async () => {
    const requestPermission = vi.fn(async () => true);
    const executor = new ToolExecutor({
      workingDirectory: '/tmp',
      requestPermission,
    });
    executor.setAuditEnabled(false);

    const result = await executor.execute(
      'mcp__github__search_code',
      {},
      { sessionId: 'sess-1', currentToolCallId: 'call-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('缺少必填参数');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mocks.callTool).not.toHaveBeenCalled();
  });
});

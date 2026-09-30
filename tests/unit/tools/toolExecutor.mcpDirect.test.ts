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
  getServerState: vi.fn(),
  wasServerReaped: vi.fn(),
  ensureConnected: vi.fn(),
}));

vi.mock('../../../src/host/tools/protocolRegistry', () => ({
  getProtocolRegistry: () => ({
    getSchemas: mocks.getSchemas,
    has: mocks.has,
    resolve: mocks.resolve,
  }),
  isProtocolToolName: vi.fn(() => false),
  resetProtocolRegistry: vi.fn(),
}));

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({
    getAllToolMeta: () => ({}),
  }),
}));

vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({
    getToolDefinitions: mocks.getToolDefinitions,
    parseMCPToolName: mocks.parseMCPToolName,
    callTool: mocks.callTool,
    getServerState: mocks.getServerState,
    wasServerReaped: mocks.wasServerReaped,
    ensureConnected: mocks.ensureConnected,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
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

const { ToolExecutor } = await import('../../../src/host/tools/toolExecutor');
const { resetToolResolver } = await import('../../../src/host/tools/dispatch/toolResolver');

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
    mocks.getServerState.mockReset();
    mocks.getServerState.mockReturnValue(undefined);
    mocks.wasServerReaped.mockReset();
    mocks.wasServerReaped.mockReturnValue(false);
    mocks.ensureConnected.mockReset();
    mocks.ensureConnected.mockResolvedValue(false);
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
      // GAP-009：sessionId 透传给 MCP，超阈值输出落盘到 session 临时目录
      { abortSignal: undefined, sessionId: 'sess-1' },
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
      { abortSignal: controller.signal, sessionId: 'sess-1' },
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
    expect(result.error).toContain('参数校验失败');
    expect(result.error).toContain('field_path=query');
    expect(result.error).toContain('category=missing_required');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it('reconnects a reaped lazy MCP server before reporting Unknown tool', async () => {
    const reapedDef = {
      name: 'mcp__x__y',
      description: '[MCP:x] y',
      inputSchema: { type: 'object' as const, properties: {} },
      requiresPermission: true,
      permissionLevel: 'network' as const,
    };
    let visible = false;
    mocks.getToolDefinitions.mockImplementation(() => (visible ? [reapedDef] : []));
    mocks.parseMCPToolName.mockImplementation((name: string) => (
      name === 'mcp__x__y' ? { serverName: 'x', toolName: 'y' } : null
    ));
    mocks.getServerState.mockReturnValue({ status: 'lazy' });
    mocks.wasServerReaped.mockReturnValue(true);
    mocks.ensureConnected.mockImplementation(async () => {
      visible = true;
      return true;
    });
    mocks.callTool.mockResolvedValue({
      toolCallId: 'call-1',
      success: true,
      output: 'ran',
      duration: 1,
    });

    const executor = new ToolExecutor({
      workingDirectory: '/tmp',
      requestPermission: vi.fn(async () => true),
    });
    executor.setAuditEnabled(false);

    const result = await executor.execute(
      'mcp__x__y',
      {},
      { sessionId: 'sess-1', currentToolCallId: 'call-1' },
    );

    expect(mocks.ensureConnected).toHaveBeenCalledWith('x');
    expect(mocks.callTool).toHaveBeenCalledWith(
      'call-1',
      'x',
      'y',
      {},
      { abortSignal: undefined, sessionId: 'sess-1' },
    );
    expect(result.success).toBe(true);
    expect(result.error ?? '').not.toContain('Unknown tool');
  });

  it('still reports Unknown tool when the name is not a reaped MCP server', async () => {
    mocks.getToolDefinitions.mockReturnValue([]);
    const executor = new ToolExecutor({
      workingDirectory: '/tmp',
      requestPermission: vi.fn(async () => true),
    });
    executor.setAuditEnabled(false);

    const result = await executor.execute(
      'not_a_tool',
      {},
      { sessionId: 'sess-1', currentToolCallId: 'call-1' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown tool: not_a_tool');
    expect(mocks.ensureConnected).not.toHaveBeenCalled();
  });
});

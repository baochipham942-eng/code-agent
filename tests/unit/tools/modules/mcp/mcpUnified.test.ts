// ============================================================================
// MCP Unified (native ToolModule) Tests — Wave 2 mcp
//
// 关键覆盖：
// - schema action enum 对齐 legacy: invoke/list_tools/list_resources/
//   read_resource/status/add_server
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码规范化
// - 6 个 action 输出格式 1:1 复刻 legacy
// - 共享单例纪律：abort 中 read_resource 走 race 不杀 client，invoke 委托给
//   executeMcpInvoke 也不杀 client；mcpClient.disconnect / removeServer 必须未调用
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

const getMCPClientMock = vi.fn();
const getMcpConfigPathMock = vi.fn();
const ensureConfigDirMock = vi.fn();
const pathExistsMock = vi.fn();
const fsReadFileMock = vi.fn();
const fsWriteFileMock = vi.fn();

vi.mock('../../../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => getMCPClientMock(),
}));

vi.mock('../../../../../src/host/config', () => ({
  getMcpConfigPath: (...args: unknown[]) => getMcpConfigPathMock(...args),
  ensureConfigDir: (...args: unknown[]) => ensureConfigDirMock(...args),
  pathExists: (...args: unknown[]) => pathExistsMock(...args),
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => fsReadFileMock(...args),
    writeFile: (...args: unknown[]) => fsWriteFileMock(...args),
  },
  readFile: (...args: unknown[]) => fsReadFileMock(...args),
  writeFile: (...args: unknown[]) => fsWriteFileMock(...args),
}));

import { mcpUnifiedModule } from '../../../../../src/host/tools/modules/mcp/mcpUnified';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/test-workspace',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

interface MockClient {
  isConnected: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  getTools: ReturnType<typeof vi.fn>;
  getResources: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  readResource: ReturnType<typeof vi.fn>;
  addServer: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  getServerState: ReturnType<typeof vi.fn>;
  // Sentinels
  disconnect: ReturnType<typeof vi.fn>;
  removeServer: ReturnType<typeof vi.fn>;
}

function makeMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue({
      connectedServers: ['filesystem'],
      inProcessServers: [],
      toolCount: 3,
      resourceCount: 1,
      promptCount: 0,
    }),
    getTools: vi.fn().mockReturnValue([]),
    getResources: vi.fn().mockReturnValue([]),
    callTool: vi.fn().mockResolvedValue({ toolCallId: 'x', success: true, output: 'ok' }),
    readResource: vi.fn().mockResolvedValue('resource-content'),
    addServer: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    getServerState: vi.fn().mockReturnValue(undefined),
    disconnect: vi.fn(),
    removeServer: vi.fn(),
    ...overrides,
  };
}

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await mcpUnifiedModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  getMCPClientMock.mockReset();
  getMcpConfigPathMock.mockReset();
  ensureConfigDirMock.mockReset();
  pathExistsMock.mockReset();
  fsReadFileMock.mockReset();
  fsWriteFileMock.mockReset();
  // defaults for config persistence
  getMcpConfigPathMock.mockReturnValue({
    new: '/tmp/test-workspace/.code-agent/mcp.json',
    legacy: '/tmp/test-workspace/.claude/settings.json',
  });
  pathExistsMock.mockResolvedValue(false);
  ensureConfigDirMock.mockResolvedValue('/tmp/test-workspace/.code-agent');
  fsReadFileMock.mockRejectedValue(new Error('ENOENT'));
  fsWriteFileMock.mockResolvedValue(undefined);
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('mcpUnifiedModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata aligned with legacy', () => {
      expect(mcpUnifiedModule.schema.name).toBe('MCPUnified');
      expect(mcpUnifiedModule.schema.category).toBe('mcp');
      expect(mcpUnifiedModule.schema.permissionLevel).toBe('network');
      expect(mcpUnifiedModule.schema.inputSchema.required).toEqual(['action']);
      const enumVals = (mcpUnifiedModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum;
      expect(enumVals).toEqual([
        'invoke',
        'list_tools',
        'list_resources',
        'read_resource',
        'status',
        'add_server',
      ]);
    });
  });

  describe('validation & errors', () => {
    it('rejects unknown action', async () => {
      const result = await run({ action: 'banana' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('Unknown action');
      }
    });

    it('rejects missing action', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ action: 'status' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal already aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await run({ action: 'status' }, makeCtx({ abortSignal: ctrl.signal }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('action: status', () => {
    it('formats connection status output 1:1 from legacy', async () => {
      const client = makeMockClient({
        getStatus: vi.fn().mockReturnValue({
          connectedServers: ['filesystem', 'github'],
          inProcessServers: [],
          toolCount: 5,
          resourceCount: 2,
          promptCount: 1,
        }),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ action: 'status' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('# MCP 连接状态');
        expect(result.output).toContain('已连接服务器: filesystem, github');
        expect(result.output).toContain('可用工具: 5');
        expect(result.output).toContain('可用资源: 2');
        expect(result.output).toContain('可用提示: 1');
        expect(result.meta).toMatchObject({
          action: 'status',
          resultKind: 'text',
          count: 2,
          truncated: false,
          toolCount: 5,
          resourceCount: 2,
          promptCount: 1,
        });
        expect(result.meta?.artifact).toMatchObject({
          kind: 'text',
          sourceTool: 'MCPUnified',
          metadata: expect.objectContaining({
            mcpStatus: true,
            action: 'status',
            count: 2,
            truncated: false,
          }),
        });
      }
    });

    it('shows 无 when no servers connected', async () => {
      const client = makeMockClient({
        getStatus: vi.fn().mockReturnValue({
          connectedServers: [],
          inProcessServers: [],
          toolCount: 0,
          resourceCount: 0,
          promptCount: 0,
        }),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ action: 'status' });
      if (result.ok) {
        expect(result.output).toContain('已连接服务器: 无');
      }
    });
  });

  describe('action: list_tools', () => {
    it('shows "no servers" hint when none connected', async () => {
      const client = makeMockClient({
        getStatus: vi.fn().mockReturnValue({
          connectedServers: [],
          inProcessServers: [],
          toolCount: 0,
          resourceCount: 0,
          promptCount: 0,
        }),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ action: 'list_tools' });
      if (result.ok) {
        expect(result.output).toBe('当前没有已连接的 MCP 服务器。');
        expect(result.meta).toMatchObject({
          action: 'list_tools',
          resultKind: 'text',
          count: 0,
          truncated: false,
        });
        expect(result.meta?.artifact).toMatchObject({
          kind: 'text',
          metadata: expect.objectContaining({ mcpToolList: true }),
        });
      }
    });

    it('groups tools by server with schema params', async () => {
      const client = makeMockClient({
        getStatus: vi.fn().mockReturnValue({
          connectedServers: ['filesystem'],
          inProcessServers: [],
          toolCount: 1,
          resourceCount: 0,
          promptCount: 0,
        }),
        getTools: vi.fn().mockReturnValue([
          {
            name: 'read_file',
            description: 'Read a file',
            serverName: 'filesystem',
            inputSchema: {
              properties: {
                path: { type: 'string', description: 'file path' },
              },
              required: ['path'],
            },
          },
        ]),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ action: 'list_tools' });
      if (result.ok) {
        expect(result.output).toContain('已连接的 MCP 服务器: filesystem');
        expect(result.output).toContain('## filesystem (1 个工具)');
        expect(result.output).toContain('### read_file');
        expect(result.output).toContain('Read a file');
        expect(result.output).toContain('参数:');
        expect(result.output).toContain('- path: string (必需)');
        expect(result.meta).toMatchObject({
          action: 'list_tools',
          resultKind: 'text',
          count: 1,
          totalCount: 1,
          truncated: false,
        });
        expect(result.meta?.artifact).toMatchObject({
          kind: 'text',
          sourceTool: 'MCPUnified',
          metadata: expect.objectContaining({
            mcpToolList: true,
            action: 'list_tools',
            count: 1,
          }),
        });
      }
    });

    it('does not expose raw cua-driver tools while the stateful facade is enabled', async () => {
      const previousCua = process.env.CODE_AGENT_ENABLE_CUA;
      const previousV2 = process.env.CODE_AGENT_CUA_STATE_V2;
      process.env.CODE_AGENT_ENABLE_CUA = '1';
      process.env.CODE_AGENT_CUA_STATE_V2 = '1';
      try {
        const client = makeMockClient({
          getStatus: vi.fn().mockReturnValue({
            connectedServers: ['cua-driver', 'filesystem'],
            inProcessServers: [],
            toolCount: 2,
            resourceCount: 0,
            promptCount: 0,
          }),
          getTools: vi.fn().mockReturnValue([
            { name: 'click', description: 'Raw click', serverName: 'cua-driver', inputSchema: {} },
            { name: 'read_file', description: 'Read', serverName: 'filesystem', inputSchema: {} },
          ]),
        });
        getMCPClientMock.mockReturnValue(client);

        const result = await run({ action: 'list_tools' });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.output).not.toContain('Raw click');
          expect(result.output).toContain('read_file');
          expect(result.meta).toMatchObject({ count: 1, totalCount: 1 });
        }
      } finally {
        if (previousCua === undefined) delete process.env.CODE_AGENT_ENABLE_CUA;
        else process.env.CODE_AGENT_ENABLE_CUA = previousCua;
        if (previousV2 === undefined) delete process.env.CODE_AGENT_CUA_STATE_V2;
        else process.env.CODE_AGENT_CUA_STATE_V2 = previousV2;
      }
    });

    it('filters tools by server when args.server provided', async () => {
      const client = makeMockClient({
        getStatus: vi.fn().mockReturnValue({
          connectedServers: ['a', 'b'],
          inProcessServers: [],
          toolCount: 2,
          resourceCount: 0,
          promptCount: 0,
        }),
        getTools: vi.fn().mockReturnValue([
          { name: 't1', description: 'A tool', serverName: 'a', inputSchema: {} },
          { name: 't2', description: 'B tool', serverName: 'b', inputSchema: {} },
        ]),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ action: 'list_tools', server: 'a' });
      if (result.ok) {
        expect(result.output).toContain('### t1');
        expect(result.output).not.toContain('### t2');
      }
    });
  });

  describe('action: list_resources', () => {
    it('shows generic empty hint when no resources', async () => {
      const client = makeMockClient({ getResources: vi.fn().mockReturnValue([]) });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ action: 'list_resources' });
      if (result.ok) {
        expect(result.output).toBe('当前没有可用的 MCP 资源。');
        expect(result.meta).toMatchObject({
          action: 'list_resources',
          resultKind: 'text',
          count: 0,
          truncated: false,
        });
        expect(result.meta?.artifact).toMatchObject({
          kind: 'text',
          metadata: expect.objectContaining({ mcpResource: true }),
        });
      }
    });

    it('shows server-specific hint when filtered to empty server', async () => {
      const client = makeMockClient({ getResources: vi.fn().mockReturnValue([]) });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ action: 'list_resources', server: 'foo' });
      if (result.ok) {
        expect(result.output).toBe("服务器 'foo' 没有提供资源。");
      }
    });

    it('groups resources by server with description and mime', async () => {
      const client = makeMockClient({
        getResources: vi.fn().mockReturnValue([
          {
            uri: 'file:///a',
            name: 'a',
            description: 'a desc',
            mimeType: 'text/plain',
            serverName: 's1',
          },
        ]),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ action: 'list_resources' });
      if (result.ok) {
        expect(result.output).toContain('共 1 个资源');
        expect(result.output).toContain('## s1');
        expect(result.output).toContain('- a');
        expect(result.output).toContain('  URI: file:///a');
        expect(result.output).toContain('  描述: a desc');
        expect(result.output).toContain('  类型: text/plain');
        expect(result.meta).toMatchObject({
          action: 'list_resources',
          resultKind: 'text',
          count: 1,
          totalCount: 1,
          truncated: false,
          resourceUris: ['file:///a'],
        });
        expect(result.meta?.artifact).toMatchObject({
          kind: 'text',
          sourceTool: 'MCPUnified',
          metadata: expect.objectContaining({
            mcpResource: true,
            action: 'list_resources',
            count: 1,
            resourceUris: ['file:///a'],
          }),
        });
      }
    });
  });

  describe('action: read_resource', () => {
    it('rejects missing args', async () => {
      const result = await run({ action: 'read_resource', server: 'fs' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('server 和 uri');
      }
    });

    it('returns NOT_INITIALIZED when server not connected', async () => {
      const client = makeMockClient({ isConnected: vi.fn().mockReturnValue(false) });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({
        action: 'read_resource',
        server: 'fs',
        uri: 'file:///a',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain("MCP 服务器 'fs' 未连接");
      }
    });

    it('returns content + meta on success', async () => {
      const client = makeMockClient({
        readResource: vi.fn().mockResolvedValue('hello world'),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({
        action: 'read_resource',
        server: 'fs',
        uri: 'file:///a',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe('hello world');
        expect(result.meta?.server).toBe('fs');
        expect(result.meta?.uri).toBe('file:///a');
        expect(result.meta?.resourceUri).toBe('file:///a');
        expect(result.meta?.action).toBe('read_resource');
        expect(result.meta?.resultKind).toBe('text');
        expect(result.meta?.count).toBe(1);
        expect(result.meta?.truncated).toBe(false);
        expect(result.meta?.artifact).toMatchObject({
          kind: 'text',
          sourceTool: 'MCPUnified',
          url: 'file:///a',
          metadata: expect.objectContaining({
            mcpResource: true,
            server: 'fs',
            resourceUri: 'file:///a',
            action: 'read_resource',
            resultKind: 'text',
          }),
        });
      }
    });

    it('wraps thrown error as DOMAIN_ERROR with chinese prefix', async () => {
      const client = makeMockClient({
        readResource: vi.fn().mockRejectedValue(new Error('not found')),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({
        action: 'read_resource',
        server: 'fs',
        uri: 'file:///x',
      });
      if (!result.ok) {
        expect(result.code).toBe('DOMAIN_ERROR');
        expect(result.error).toContain('读取资源失败: not found');
      }
    });

    it('returns ABORTED if signal aborts mid-read, without disconnecting client', async () => {
      const ctrl = new AbortController();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const client = makeMockClient({
        readResource: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      getMCPClientMock.mockReturnValue(client);
      const promise = run(
        { action: 'read_resource', server: 'fs', uri: 'file:///a' },
        ctx,
      );
      setTimeout(() => ctrl.abort(), 5);
      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('ABORTED');
        expect(result.meta).toMatchObject({
          server: 'fs',
          resourceUri: 'file:///a',
          action: 'read_resource',
          resultKind: 'text',
          count: 0,
          truncated: false,
          errorCode: 'ABORTED',
        });
      }

      // Sentinel: shared client must not be disconnected on abort
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.removeServer).not.toHaveBeenCalled();
    });
  });

  describe('action: invoke (delegates to executeMcpInvoke)', () => {
    it('passes server/tool/arguments through to mcpClient.callTool', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);
      const result = await run({
        action: 'invoke',
        server: 'filesystem',
        tool: 'read_file',
        arguments: { path: '/tmp/x' },
      });
      expect(result.ok).toBe(true);
      const call = client.callTool.mock.calls[0];
      expect(call[1]).toBe('filesystem');
      expect(call[2]).toBe('read_file');
      expect(call[3]).toEqual({ path: '/tmp/x' });
      if (result.ok) {
        expect(result.meta).toMatchObject({
          server: 'filesystem',
          toolName: 'read_file',
          action: 'invoke',
          resultKind: 'process-output',
          count: 1,
          truncated: false,
        });
        expect(result.meta?.artifact).toMatchObject({
          kind: 'process-output',
          metadata: expect.objectContaining({ mcpToolCall: true }),
        });
      }
    });

    it('does not disconnect on aborted invoke', async () => {
      const ctrl = new AbortController();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const client = makeMockClient({
        callTool: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      getMCPClientMock.mockReturnValue(client);
      const promise = run(
        { action: 'invoke', server: 's', tool: 't', arguments: {} },
        ctx,
      );
      setTimeout(() => ctrl.abort(), 5);
      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.removeServer).not.toHaveBeenCalled();
    });
  });

  describe('action: add_server (delegates to executeMcpAddServer)', () => {
    it('SSE happy path through unified', async () => {
      const client = makeMockClient({
        getServerState: vi.fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce({ status: 'connected', toolCount: 1 }),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({
        action: 'add_server',
        name: 'srv',
        type: 'sse',
        serverUrl: 'https://x.com',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('# MCP Server Added: srv');
        expect(result.meta).toMatchObject({
          server: 'srv',
          action: 'add_server',
          resultKind: 'process-output',
          count: 1,
          truncated: false,
        });
        expect(result.meta?.artifact).toMatchObject({
          kind: 'process-output',
          metadata: expect.objectContaining({ mcpServer: true }),
        });
      }
    });

    it('HTTP Streamable happy path through unified', async () => {
      const client = makeMockClient({
        getServerState: vi.fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce({ status: 'connected', toolCount: 2 }),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({
        action: 'add_server',
        name: 'jira',
        type: 'http-streamable',
        serverUrl: 'https://mcp.example.com/mcp',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Type: http-streamable');
        expect(result.meta).toMatchObject({
          server: 'jira',
          action: 'add_server',
          type: 'http-streamable',
          count: 2,
        });
      }
    });
  });

  describe('progress', () => {
    it('emits starting + completing for status action', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);
      const onProgress = vi.fn();
      await run({ action: 'status' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});

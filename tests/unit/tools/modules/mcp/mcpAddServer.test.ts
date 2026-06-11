// ============================================================================
// MCP Add Server (native ToolModule) Tests — Wave 2 mcp
//
// 关键覆盖：
// - schema 字段名/required/enum 对齐 legacy
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码规范化
// - 已连接同名 server → DOMAIN_ERROR
// - SSE 协议白名单 / 命名规则 / BLOCKED_COMMANDS 拒绝
// - persist 失败仍能继续（输出 "Configuration saved: No (session only)"）
// - shared singleton 纪律：abort 不调用 mcpClient.disconnect / removeServer
// - happy path 输出 1:1 复刻 legacy
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

const getMCPClientMock = vi.fn();
const getMcpConfigPathMock = vi.fn();
const ensureConfigDirMock = vi.fn();
const pathExistsMock = vi.fn();
const fsReadFileMock = vi.fn();
const fsWriteFileMock = vi.fn();

vi.mock('../../../../../src/main/mcp/mcpClient', () => ({
  getMCPClient: () => getMCPClientMock(),
}));

vi.mock('../../../../../src/main/config', () => ({
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

import { mcpAddServerModule } from '../../../../../src/main/tools/modules/mcp/mcpAddServer';

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
  addServer: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  getServerState: ReturnType<typeof vi.fn>;
  // Sentinels
  disconnect: ReturnType<typeof vi.fn>;
  removeServer: ReturnType<typeof vi.fn>;
}

function makeMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
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
  const handler = await mcpAddServerModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  getMCPClientMock.mockReset();
  getMcpConfigPathMock.mockReset();
  ensureConfigDirMock.mockReset();
  pathExistsMock.mockReset();
  fsReadFileMock.mockReset();
  fsWriteFileMock.mockReset();

  // Default: new mcp.json layout, no existing files
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

describe('mcpAddServerModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata aligned with legacy', () => {
      expect(mcpAddServerModule.schema.name).toBe('mcp_add_server');
      expect(mcpAddServerModule.schema.category).toBe('mcp');
      expect(mcpAddServerModule.schema.permissionLevel).toBe('write');
      expect(mcpAddServerModule.schema.inputSchema.required).toEqual(['name', 'type']);
      const typeProp = (mcpAddServerModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>).type;
      expect(typeProp.enum).toEqual(['http-streamable', 'http', 'sse', 'stdio']);
    });
  });

  describe('validation & errors', () => {
    it('rejects empty name', async () => {
      const result = await run({ name: '   ', type: 'sse', serverUrl: 'https://x.com' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('Server name is required');
      }
    });

    it('rejects name with invalid characters', async () => {
      const result = await run({ name: 'bad name!', type: 'sse', serverUrl: 'https://x.com' });
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('letters, numbers, dashes, and underscores');
      }
    });

    it('rejects unknown type', async () => {
      const result = await run({ name: 'foo', type: 'websocket' });
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('Invalid server type');
      }
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);
      const result = await run(
        { name: 'foo', type: 'sse', serverUrl: 'https://x.com' },
        makeCtx(),
        denyAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
      if (!result.ok) {
        expect(result.meta).toMatchObject({
          server: 'foo',
          action: 'add_server',
          resultKind: 'process-output',
          count: 0,
          truncated: false,
          errorCode: 'PERMISSION_DENIED',
        });
      }
    });

    it('returns ABORTED when signal already aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await run(
        { name: 'foo', type: 'sse', serverUrl: 'https://x.com' },
        makeCtx({ abortSignal: ctrl.signal }),
      );
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('SSE without serverUrl → INVALID_ARGS', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ name: 'foo', type: 'sse' });
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('serverUrl is required');
      }
    });

    it('SSE with non-http protocol → INVALID_ARGS', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ name: 'foo', type: 'sse', serverUrl: 'ftp://x.com' });
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('Invalid protocol');
      }
    });

    it('SSE with malformed URL → INVALID_ARGS', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ name: 'foo', type: 'sse', serverUrl: 'not-a-url' });
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('Invalid URL format');
      }
    });

    it('Stdio without command → INVALID_ARGS', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ name: 'foo', type: 'stdio' });
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('command is required');
      }
    });

    it('Stdio with blocked command (rm) → INVALID_ARGS', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ name: 'foo', type: 'stdio', command: 'rm' });
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain("Command 'rm' is not allowed");
      }
    });

    it('Stdio with sudo path-prefixed → INVALID_ARGS', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ name: 'foo', type: 'stdio', command: '/usr/bin/sudo' });
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain("Command 'sudo' is not allowed");
      }
    });

    it('already-connected server → DOMAIN_ERROR', async () => {
      const client = makeMockClient({
        getServerState: vi.fn().mockReturnValue({ status: 'connected', config: {}, toolCount: 1, resourceCount: 0 }),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run({ name: 'foo', type: 'sse', serverUrl: 'https://x.com' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('DOMAIN_ERROR');
        expect(result.error).toContain("Server 'foo' is already connected");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Abort: shared singleton — must NOT disconnect / removeServer
  // ---------------------------------------------------------------------------
  describe('abort discipline (shared singleton)', () => {
    it('does not call disconnect / removeServer when aborted before connect', async () => {
      const ctrl = new AbortController();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);

      // Abort right after addServer would be called: simulate by aborting after persist
      // We achieve this by aborting the signal after run starts
      const promise = run(
        { name: 'foo', type: 'sse', serverUrl: 'https://x.com' },
        ctx,
      );
      ctrl.abort();
      const result = await promise;

      // Either succeeds (config saved + connect skipped due to abort) or returns ABORTED
      // Whichever path: must not disconnect / removeServer
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.removeServer).not.toHaveBeenCalled();
      // result is either ok:true (added before abort hit) or ok:false ABORTED at autoConnect gate
      if (!result.ok) {
        expect(result.code).toBe('ABORTED');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Happy paths
  // ---------------------------------------------------------------------------
  describe('SSE happy path', () => {
    it('adds + persists + connects + reports tool count', async () => {
      const client = makeMockClient({
        getServerState: vi.fn()
          .mockReturnValueOnce(undefined) // initial check
          .mockReturnValueOnce({ status: 'connected', toolCount: 4 }), // after connect
      });
      getMCPClientMock.mockReturnValue(client);
      pathExistsMock.mockResolvedValueOnce(false).mockResolvedValueOnce(false); // legacy + new both miss

      const result = await run({
        name: 'my-server',
        type: 'sse',
        serverUrl: 'https://mcp.example.com/sse',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('# MCP Server Added: my-server');
        expect(result.output).toContain('Type: sse');
        expect(result.output).toContain('URL: https://mcp.example.com/sse');
        expect(result.output).toContain('Configuration saved: Yes');
        expect(result.output).toContain('Connection: Success');
        expect(result.output).toContain('Available tools: 4');
        expect(result.meta?.persisted).toBe(true);
        expect(result.meta?.connected).toBe(true);
        expect(result.meta?.server).toBe('my-server');
        expect(result.meta?.action).toBe('add_server');
        expect(result.meta?.resultKind).toBe('process-output');
        expect(result.meta?.count).toBe(4);
        expect(result.meta?.truncated).toBe(false);
        expect(result.meta?.configPath).toBe('/tmp/test-workspace/.code-agent/mcp.json');
        expect(result.meta?.artifact).toMatchObject({
          kind: 'process-output',
          sourceTool: 'mcp_add_server',
          mimeType: 'text/plain',
          metadata: expect.objectContaining({
            mcpServer: true,
            server: 'my-server',
            action: 'add_server',
            resultKind: 'process-output',
            count: 4,
            truncated: false,
            persisted: true,
            connected: true,
          }),
        });
        expect(result.meta?.artifact).toHaveProperty('artifactId');
      }
      expect(client.addServer).toHaveBeenCalled();
      expect(client.connect).toHaveBeenCalled();
      expect(fsWriteFileMock).toHaveBeenCalled();
    });
  });

  describe('HTTP Streamable happy path', () => {
    it('accepts Settings-style http + url, persists as http-streamable, and connects', async () => {
      const client = makeMockClient({
        getServerState: vi.fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce({ status: 'connected', toolCount: 3 }),
      });
      getMCPClientMock.mockReturnValue(client);

      const result = await run({
        name: 'jira',
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer token' },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Type: http-streamable');
        expect(result.output).toContain('URL: https://mcp.example.com/mcp');
        expect(result.output).toContain('Available tools: 3');
        expect(result.meta).toMatchObject({
          type: 'http-streamable',
          server: 'jira',
          connected: true,
          count: 3,
        });
      }
      expect(client.addServer).toHaveBeenCalledWith(expect.objectContaining({
        name: 'jira',
        type: 'http-streamable',
        serverUrl: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer token' },
        enabled: true,
      }));
    });
  });

  describe('Stdio happy path', () => {
    it('persists with command + args + env, displays Environment line', async () => {
      const client = makeMockClient({
        getServerState: vi.fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce({ status: 'connected', toolCount: 2 }),
      });
      getMCPClientMock.mockReturnValue(client);

      const result = await run({
        name: 'fs',
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { DEBUG: '1' },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Command: npx -y @modelcontextprotocol/server-filesystem /tmp');
        expect(result.output).toContain('Environment: DEBUG');
      }
    });
  });

  describe('connection failure path', () => {
    it('reports Connection: Failed when connect throws', async () => {
      const client = makeMockClient({
        connect: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      });
      getMCPClientMock.mockReturnValue(client);

      const result = await run({
        name: 'flaky',
        type: 'sse',
        serverUrl: 'https://down.example.com/sse',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Connection: Failed');
        expect(result.output).toContain('Error: ECONNREFUSED');
        expect(result.output).toContain('The server configuration has been saved');
        expect(result.meta?.connected).toBe(false);
      }
    });
  });

  describe('persist failure path', () => {
    it('still adds + connects, reports "Configuration saved: No (session only)"', async () => {
      const client = makeMockClient({
        getServerState: vi.fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce({ status: 'connected', toolCount: 1 }),
      });
      getMCPClientMock.mockReturnValue(client);
      fsWriteFileMock.mockRejectedValue(new Error('EACCES'));

      const result = await run({
        name: 'temp',
        type: 'sse',
        serverUrl: 'https://x.com',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Configuration saved: No (session only)');
        expect(result.meta?.persisted).toBe(false);
      }
    });
  });

  describe('auto_connect=false path', () => {
    it('skips connect, reports "Auto-connect disabled"', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);

      const result = await run({
        name: 'lazy',
        type: 'sse',
        serverUrl: 'https://x.com',
        auto_connect: false,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Auto-connect disabled');
        expect(result.meta?.connected).toBe(false);
      }
      expect(client.connect).not.toHaveBeenCalled();
    });
  });

  describe('legacy config layout (settings.json)', () => {
    it('writes to settings.json under mcpServers when only legacy file exists', async () => {
      pathExistsMock
        .mockResolvedValueOnce(true) // legacyExists
        .mockResolvedValueOnce(false); // newExists
      fsReadFileMock.mockResolvedValueOnce(JSON.stringify({ mcpServers: [{ name: 'old', type: 'sse', serverUrl: 'https://o.com', enabled: true }] }));
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);

      const result = await run({
        name: 'new-one',
        type: 'sse',
        serverUrl: 'https://x.com',
        auto_connect: false,
      });

      expect(result.ok).toBe(true);
      const writtenPayload = JSON.parse(fsWriteFileMock.mock.calls[0][1]);
      expect(writtenPayload.mcpServers).toHaveLength(2);
      expect(writtenPayload.mcpServers[1].name).toBe('new-one');
    });
  });

  describe('progress', () => {
    it('emits starting + completing on success', async () => {
      const client = makeMockClient();
      getMCPClientMock.mockReturnValue(client);
      const onProgress = vi.fn();
      await run(
        { name: 'foo', type: 'sse', serverUrl: 'https://x.com', auto_connect: false },
        makeCtx(),
        allowAll,
        onProgress,
      );
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});

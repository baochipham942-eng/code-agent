// ============================================================================
// MCP Invoke (native ToolModule) Tests — Wave 2 mcp
//
// 关键覆盖：
// - schema 字段名、required 全部对齐 legacy
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码规范化
// - MCP client 是共享单例：abort 中途必须返回 ABORTED 且 **不调用 disconnect /
//   removeServer / 不杀 server 进程**（其他 in-flight invoke 还在跑）
// - server 未连接 → NOT_INITIALIZED + connectedServers 列表
// - callTool 返回 success:false → DOMAIN_ERROR
// - happy path 输出 1:1 复刻 legacy（含 metadata.server/tool/duration）
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

vi.mock('../../../../../src/main/mcp/mcpClient', () => ({
  getMCPClient: () => getMCPClientMock(),
}));

import { mcpInvokeModule } from '../../../../../src/main/tools/modules/mcp/mcpInvoke';

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
  callTool: ReturnType<typeof vi.fn>;
  // Sentinels: must NOT be called by the native tool on abort
  disconnect: ReturnType<typeof vi.fn>;
  removeServer: ReturnType<typeof vi.fn>;
}

function makeMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue({
      connectedServers: ['filesystem', 'github'],
      inProcessServers: [],
      toolCount: 5,
      resourceCount: 0,
      promptCount: 0,
    }),
    callTool: vi.fn(),
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
  const handler = await mcpInvokeModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const VALID_ARGS = {
  server: 'filesystem',
  tool: 'read_file',
  arguments: { path: '/tmp/test.txt' },
};

beforeEach(() => {
  getMCPClientMock.mockReset();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('mcpInvokeModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata aligned with legacy', () => {
      expect(mcpInvokeModule.schema.name).toBe('mcp');
      expect(mcpInvokeModule.schema.category).toBe('mcp');
      expect(mcpInvokeModule.schema.permissionLevel).toBe('network');
      expect(mcpInvokeModule.schema.inputSchema.required).toEqual(['server', 'tool']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing server', async () => {
      const result = await run({ tool: 'read_file' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('server 和 tool');
      }
    });

    it('rejects missing tool', async () => {
      const result = await run({ server: 'fs' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty server string', async () => {
      const result = await run({ server: '', tool: 'read_file' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run(VALID_ARGS, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal already aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await run(VALID_ARGS, makeCtx({ abortSignal: ctrl.signal }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED with connectedServers list when server not connected', async () => {
      const client = makeMockClient({
        isConnected: vi.fn().mockReturnValue(false),
        getStatus: vi.fn().mockReturnValue({
          connectedServers: ['github', 'deepwiki'],
          inProcessServers: [],
          toolCount: 0,
          resourceCount: 0,
          promptCount: 0,
        }),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run(VALID_ARGS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain("MCP 服务器 'filesystem' 未连接");
        expect(result.error).toContain('github, deepwiki');
      }
    });

    it('NOT_INITIALIZED message says 无 when no other servers connected', async () => {
      const client = makeMockClient({
        isConnected: vi.fn().mockReturnValue(false),
        getStatus: vi.fn().mockReturnValue({
          connectedServers: [],
          inProcessServers: [],
          toolCount: 0,
          resourceCount: 0,
          promptCount: 0,
        }),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run(VALID_ARGS);
      if (!result.ok) {
        expect(result.error).toContain('已连接的服务器: 无');
      }
    });

    it('wraps callTool success:false as DOMAIN_ERROR', async () => {
      const client = makeMockClient({
        callTool: vi.fn().mockResolvedValue({
          toolCallId: 'x',
          success: false,
          error: 'Tool execution failed: invalid path',
        }),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run(VALID_ARGS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('DOMAIN_ERROR');
        expect(result.error).toBe('Tool execution failed: invalid path');
      }
    });

    it('wraps thrown exception as DOMAIN_ERROR with formatted message', async () => {
      const client = makeMockClient({
        callTool: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run(VALID_ARGS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('DOMAIN_ERROR');
        expect(result.error).toContain('MCP 工具调用异常: connection refused');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Abort mid-flight — MCP server is shared singleton (stdio subprocess).
  // Native tool MUST NOT disconnect / removeServer on abort. Other in-flight
  // invokes from sibling tool calls keep using the same client / server.
  // ---------------------------------------------------------------------------
  describe('abort mid-flight (shared singleton discipline)', () => {
    it('returns ABORTED when signal aborts during a hanging callTool', async () => {
      const ctrl = new AbortController();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const client = makeMockClient({
        // Simulate a hanging MCP call (e.g. remote SSE that never responds)
        callTool: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      getMCPClientMock.mockReturnValue(client);

      const promise = run(VALID_ARGS, ctx);
      setTimeout(() => ctrl.abort(), 5);
      const result = await promise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('ABORTED');
        expect(result.error).toBe('aborted');
      }

      // CRITICAL: native tool must NOT disconnect / removeServer the shared client on abort
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.removeServer).not.toHaveBeenCalled();
    });

    it('passes abortSignal into mcpClient.callTool so SDK can cancel pending request', async () => {
      const ctrl = new AbortController();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const client = makeMockClient({
        callTool: vi.fn().mockResolvedValue({ toolCallId: 'x', success: true, output: 'ok' }),
      });
      getMCPClientMock.mockReturnValue(client);

      await run(VALID_ARGS, ctx);

      const callArgs = client.callTool.mock.calls[0];
      expect(callArgs).toBeDefined();
      // signature: callTool(toolCallId, server, tool, args, options)
      expect(callArgs[1]).toBe('filesystem');
      expect(callArgs[2]).toBe('read_file');
      expect(callArgs[4]).toBeDefined();
      expect(callArgs[4].abortSignal).toBe(ctrl.signal);
    });
  });

  describe('happy path output', () => {
    it('returns output and metadata on success', async () => {
      const client = makeMockClient({
        callTool: vi.fn().mockResolvedValue({
          toolCallId: 'x',
          success: true,
          output: 'file contents',
          duration: 42,
        }),
      });
      getMCPClientMock.mockReturnValue(client);

      const result = await run(VALID_ARGS);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe('file contents');
        expect(result.meta?.server).toBe('filesystem');
        expect(result.meta?.tool).toBe('read_file');
        expect(result.meta?.duration).toBe(42);
      }
    });

    it('falls back to "执行成功" when output is empty', async () => {
      const client = makeMockClient({
        callTool: vi.fn().mockResolvedValue({ toolCallId: 'x', success: true, output: '' }),
      });
      getMCPClientMock.mockReturnValue(client);
      const result = await run(VALID_ARGS);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('执行成功');
    });

    it('passes empty arguments object when args.arguments missing', async () => {
      const client = makeMockClient({
        callTool: vi.fn().mockResolvedValue({ toolCallId: 'x', success: true, output: 'ok' }),
      });
      getMCPClientMock.mockReturnValue(client);
      await run({ server: 'fs', tool: 'list' });
      const callArgs = client.callTool.mock.calls[0];
      expect(callArgs[3]).toEqual({}); // arguments = {}
    });
  });

  describe('progress', () => {
    it('emits starting + completing on success', async () => {
      const client = makeMockClient({
        callTool: vi.fn().mockResolvedValue({ toolCallId: 'x', success: true, output: 'ok' }),
      });
      getMCPClientMock.mockReturnValue(client);
      const onProgress = vi.fn();
      await run(VALID_ARGS, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});

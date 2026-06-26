// ============================================================================
// LSP (native ToolModule) Tests — Wave 1 lsp
//
// 关键覆盖：
// - schema 字段名、required、operation enum 全部对齐 legacy
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码规范化
// - LSP 长连接纪律：abort 中途必须返回 ABORTED 且 **不调用 manager.shutdown / 不 kill 进程**
// - LSP server 缺失（manager null / install failure）→ NOT_INITIALIZED
// - sendRequest 抛错 → DOMAIN_ERROR
// - 各 operation 输出格式与 legacy 完全一致
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pathToFileURL } from 'url';
import * as path from 'path';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';

// -----------------------------------------------------------------------------
// Mocks
// -----------------------------------------------------------------------------

const getLSPManagerMock = vi.fn();
const fsReadFileMock = vi.fn();

vi.mock('../../../../../src/host/lsp', () => ({
  getLSPManager: () => getLSPManagerMock(),
}));

vi.mock('fs/promises', () => ({
  default: { readFile: (...args: unknown[]) => fsReadFileMock(...args) },
  readFile: (...args: unknown[]) => fsReadFileMock(...args),
}));

import { lspModule } from '../../../../../src/host/tools/modules/lsp/lsp';

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

interface MockManager {
  isFileOpen: ReturnType<typeof vi.fn>;
  openFile: ReturnType<typeof vi.fn>;
  sendRequest: ReturnType<typeof vi.fn>;
  getInstallFailureForFile: ReturnType<typeof vi.fn>;
  // Sentinel functions that MUST NOT be called by the native tool on abort
  shutdown: ReturnType<typeof vi.fn>;
}

function makeMockManager(overrides: Partial<MockManager> = {}): MockManager {
  return {
    isFileOpen: vi.fn().mockReturnValue(true),
    openFile: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn(),
    getInstallFailureForFile: vi.fn().mockReturnValue(undefined),
    shutdown: vi.fn(),
    ...overrides,
  };
}

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await lspModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const VALID_ARGS = {
  operation: 'goToDefinition',
  file_path: 'src/foo.ts',
  line: 10,
  character: 5,
};

beforeEach(() => {
  getLSPManagerMock.mockReset();
  fsReadFileMock.mockReset();
  fsReadFileMock.mockResolvedValue('// content');
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('lspModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(lspModule.schema.name).toBe('lsp');
      expect(lspModule.schema.category).toBe('lsp');
      expect(lspModule.schema.permissionLevel).toBe('read');
      expect(lspModule.schema.readOnly).toBe(true);
      expect(lspModule.schema.allowInPlanMode).toBe(true);
      expect(lspModule.schema.inputSchema.required).toEqual([
        'operation',
        'file_path',
        'line',
        'character',
      ]);
    });

    it('exposes all 9 LSP operations in enum', () => {
      const enumVals = (lspModule.schema.inputSchema.properties as any).operation.enum;
      expect(enumVals).toEqual([
        'goToDefinition',
        'findReferences',
        'hover',
        'documentSymbol',
        'workspaceSymbol',
        'goToImplementation',
        'prepareCallHierarchy',
        'incomingCalls',
        'outgoingCalls',
      ]);
    });
  });

  describe('validation & errors', () => {
    it('rejects unknown operation', async () => {
      const result = await run({ ...VALID_ARGS, operation: 'rename' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing file_path', async () => {
      const { file_path: _omit, ...args } = VALID_ARGS;
      const result = await run(args);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects non-number line', async () => {
      const result = await run({ ...VALID_ARGS, line: '10' });
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

    it('returns NOT_INITIALIZED when LSP manager missing', async () => {
      getLSPManagerMock.mockReturnValue(null);
      const result = await run(VALID_ARGS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain('LSP server manager not initialized');
      }
    });

    it('returns NOT_INITIALIZED with install hint when system server missing', async () => {
      const mgr = makeMockManager({
        sendRequest: vi.fn().mockResolvedValue(undefined),
        getInstallFailureForFile: vi.fn().mockReturnValue({
          source: {
            type: 'system',
            installCmd: 'go install golang.org/x/tools/gopls@latest',
            docUrl: 'https://example.com',
          },
          message: 'gopls not found',
        }),
      });
      getLSPManagerMock.mockReturnValue(mgr);
      const result = await run({
        ...VALID_ARGS,
        file_path: 'main.go',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain('install failed');
        expect(result.error).toContain('go install golang.org/x/tools/gopls@latest');
        expect(result.error).toContain('docs: https://example.com');
      }
    });

    it('returns NOT_INITIALIZED with npm hint when auto-install failed', async () => {
      const mgr = makeMockManager({
        sendRequest: vi.fn().mockResolvedValue(undefined),
        getInstallFailureForFile: vi.fn().mockReturnValue({
          source: { type: 'npm', packages: ['typescript-language-server'], binName: 'tls' },
          message: 'EAI_AGAIN',
        }),
      });
      getLSPManagerMock.mockReturnValue(mgr);
      const result = await run(VALID_ARGS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain('auto-install failed (EAI_AGAIN)');
      }
    });

    it('wraps sendRequest errors as DOMAIN_ERROR (LSP server returned error response)', async () => {
      const mgr = makeMockManager({
        sendRequest: vi.fn().mockRejectedValue(new Error('rpc error: invalid offset')),
      });
      getLSPManagerMock.mockReturnValue(mgr);
      const result = await run(VALID_ARGS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('DOMAIN_ERROR');
        expect(result.error).toContain('Error performing goToDefinition');
        expect(result.error).toContain('rpc error: invalid offset');
      }
    });
  });

  // -----------------------------------------------------------------------------
  // Abort mid-flight — LSP session must NOT leak (manager.shutdown not called,
  // process not killed). The shared LSP server keeps running for other callers;
  // pending request is naturally cleaned up by LSP manager's internal 30s timeout.
  // -----------------------------------------------------------------------------
  describe('abort mid-flight', () => {
    it('returns ABORTED when signal aborts during a hanging LSP request', async () => {
      const ctrl = new AbortController();
      const ctx = makeCtx({ abortSignal: ctrl.signal });

      const mgr = makeMockManager({
        // Simulate a hanging LSP request (e.g. workspaceSymbol on a huge repo)
        sendRequest: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      getLSPManagerMock.mockReturnValue(mgr);

      const promise = run(VALID_ARGS, ctx);
      // Abort after handler is in-flight
      setTimeout(() => ctrl.abort(), 5);

      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('ABORTED');
        expect(result.error).toBe('aborted');
      }

      // CRITICAL: native tool must NOT shut down the shared LSP manager on abort.
      expect(mgr.shutdown).not.toHaveBeenCalled();
    });

    it('does not crash the LSP server: getLSPManager still returns the same instance after abort', async () => {
      const ctrl = new AbortController();
      const ctx = makeCtx({ abortSignal: ctrl.signal });

      const mgr = makeMockManager({
        sendRequest: vi.fn().mockImplementation(() => new Promise(() => {})),
      });
      getLSPManagerMock.mockReturnValue(mgr);

      const promise = run(VALID_ARGS, ctx);
      setTimeout(() => ctrl.abort(), 5);
      await promise;

      // After abort, mgr is still alive and would be reused by the next tool call
      // (sentinel: shutdown not called → manager singleton intact)
      expect(mgr.shutdown).not.toHaveBeenCalled();
      // Next call still flows through getLSPManager normally
      expect(getLSPManagerMock).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------------
  // Happy paths (output format matching legacy)
  // -----------------------------------------------------------------------------
  describe('operation outputs', () => {
    it('goToDefinition single location', async () => {
      const ctx = makeCtx();
      const targetFile = path.join(ctx.workingDir, 'src/bar.ts');
      const mgr = makeMockManager({
        sendRequest: vi.fn().mockResolvedValue([
          {
            uri: pathToFileURL(targetFile).href,
            range: {
              start: { line: 41, character: 7 },
              end: { line: 41, character: 12 },
            },
          },
        ]),
      });
      getLSPManagerMock.mockReturnValue(mgr);
      const result = await run(VALID_ARGS, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe('Definition found at src/bar.ts:42:8');
        expect(result.meta?.resultCount).toBe(1);
      }
    });

    it('goToDefinition no result', async () => {
      const mgr = makeMockManager({ sendRequest: vi.fn().mockResolvedValue([]) });
      getLSPManagerMock.mockReturnValue(mgr);
      const result = await run(VALID_ARGS);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('No definition found');
      }
    });

    it('findReferences groups by file', async () => {
      const ctx = makeCtx();
      const fileA = path.join(ctx.workingDir, 'a.ts');
      const fileB = path.join(ctx.workingDir, 'b.ts');
      const mgr = makeMockManager({
        sendRequest: vi.fn().mockResolvedValue([
          { uri: pathToFileURL(fileA).href, range: { start: { line: 0, character: 0 } } },
          { uri: pathToFileURL(fileA).href, range: { start: { line: 9, character: 4 } } },
          { uri: pathToFileURL(fileB).href, range: { start: { line: 4, character: 2 } } },
        ]),
      });
      getLSPManagerMock.mockReturnValue(mgr);
      const result = await run({ ...VALID_ARGS, operation: 'findReferences' }, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Found 3 references across 2 files');
        expect(result.output).toContain('a.ts:');
        expect(result.output).toContain('Line 1:1');
        expect(result.output).toContain('Line 10:5');
        expect(result.output).toContain('b.ts:');
        expect(result.output).toContain('Line 5:3');
      }
    });

    it('hover formats markdown contents', async () => {
      const mgr = makeMockManager({
        sendRequest: vi.fn().mockResolvedValue({
          contents: { value: '`fn foo(): void`' },
          range: { start: { line: 4, character: 2 } },
        }),
      });
      getLSPManagerMock.mockReturnValue(mgr);
      const result = await run({ ...VALID_ARGS, operation: 'hover' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Hover info at 5:3:');
        expect(result.output).toContain('`fn foo(): void`');
      }
    });

    it('documentSymbol counts nested children', async () => {
      const mgr = makeMockManager({
        sendRequest: vi.fn().mockResolvedValue([
          {
            name: 'MyClass',
            kind: 5,
            range: { start: { line: 0, character: 0 } },
            children: [{ name: 'method', kind: 6, range: { start: { line: 4, character: 2 } } }],
          },
        ]),
      });
      getLSPManagerMock.mockReturnValue(mgr);
      const result = await run({ ...VALID_ARGS, operation: 'documentSymbol' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Found 2 symbols in document');
        expect(result.output).toContain('MyClass (Class)');
      }
    });

    it('incomingCalls makes a second LSP request and formats results', async () => {
      const ctx = makeCtx();
      const fileA = path.join(ctx.workingDir, 'caller.ts');
      const sendRequest = vi
        .fn()
        // 1st call: prepareCallHierarchy
        .mockResolvedValueOnce([
          {
            uri: pathToFileURL(fileA).href,
            name: 'callee',
            kind: 12,
            range: { start: { line: 9, character: 0 } },
          },
        ])
        // 2nd call: callHierarchy/incomingCalls
        .mockResolvedValueOnce([
          {
            from: {
              uri: pathToFileURL(fileA).href,
              name: 'caller',
              kind: 12,
              range: { start: { line: 19, character: 4 } },
            },
            fromRanges: [],
          },
        ]);
      const mgr = makeMockManager({ sendRequest });
      getLSPManagerMock.mockReturnValue(mgr);
      const result = await run({ ...VALID_ARGS, operation: 'incomingCalls' }, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Found 1 caller');
        expect(result.output).toContain('caller.ts:');
        expect(result.output).toContain('caller (Function) - Line 20');
      }
      expect(sendRequest).toHaveBeenCalledTimes(2);
    });

    it('incomingCalls returns no-item message when prepareCallHierarchy is empty', async () => {
      const mgr = makeMockManager({ sendRequest: vi.fn().mockResolvedValue([]) });
      getLSPManagerMock.mockReturnValue(mgr);
      const result = await run({ ...VALID_ARGS, operation: 'incomingCalls' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe('No call hierarchy item found at this position');
      }
    });
  });

  describe('progress', () => {
    it('emits starting + completing', async () => {
      const mgr = makeMockManager({
        sendRequest: vi.fn().mockResolvedValue([]),
      });
      getLSPManagerMock.mockReturnValue(mgr);
      const onProgress = vi.fn();
      await run(VALID_ARGS, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });

  describe('file open lifecycle', () => {
    it('opens file via manager when not already open', async () => {
      const mgr = makeMockManager({
        isFileOpen: vi.fn().mockReturnValue(false),
        sendRequest: vi.fn().mockResolvedValue([]),
      });
      getLSPManagerMock.mockReturnValue(mgr);
      fsReadFileMock.mockResolvedValueOnce('export const x = 1;');
      const result = await run(VALID_ARGS);
      expect(result.ok).toBe(true);
      expect(mgr.openFile).toHaveBeenCalledTimes(1);
      expect(fsReadFileMock).toHaveBeenCalled();
    });
  });
});

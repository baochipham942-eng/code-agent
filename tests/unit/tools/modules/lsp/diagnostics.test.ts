// ============================================================================
// Diagnostics (native ToolModule) Tests — Wave 1 lsp
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pathToFileURL } from 'url';
import * as path from 'path';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mock LSP manager
// -----------------------------------------------------------------------------

const getLSPManagerMock = vi.fn();

vi.mock('../../../../../src/main/lsp', () => ({
  getLSPManager: () => getLSPManagerMock(),
}));

import { diagnosticsModule } from '../../../../../src/main/tools/modules/lsp/diagnostics';

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

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await diagnosticsModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  getLSPManagerMock.mockReset();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('diagnosticsModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(diagnosticsModule.schema.name).toBe('diagnostics');
      expect(diagnosticsModule.schema.category).toBe('lsp');
      expect(diagnosticsModule.schema.permissionLevel).toBe('read');
      expect(diagnosticsModule.schema.readOnly).toBe(true);
      expect(diagnosticsModule.schema.allowInPlanMode).toBe(true);
      expect(diagnosticsModule.schema.inputSchema.required).toEqual([]);
      const enumVals = (diagnosticsModule.schema.inputSchema.properties as any).severity_filter.enum;
      expect(enumVals).toEqual(['error', 'warning', 'all']);
    });
  });

  describe('validation & errors', () => {
    it('rejects non-string file_path', async () => {
      const result = await run({ file_path: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects unknown severity_filter', async () => {
      const result = await run({ severity_filter: 'verbose' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({}, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({}, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED when LSP manager missing', async () => {
      getLSPManagerMock.mockReturnValue(null);
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain('LSP server manager not initialized');
      }
    });
  });

  describe('happy paths', () => {
    it('returns no-diagnostics message when file is clean', async () => {
      getLSPManagerMock.mockReturnValue({
        getFileDiagnostics: () => [],
        getDiagnostics: () => new Map(),
      });
      const result = await run({ file_path: 'src/foo.ts' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('No diagnostics found for src/foo.ts');
        expect(result.output).toContain('filter: all');
      }
    });

    it('formats single-file errors and warnings with severity filter all', async () => {
      const ctx = makeCtx();
      const fileAbs = path.resolve(ctx.workingDir, 'src/foo.ts');
      getLSPManagerMock.mockReturnValue({
        getFileDiagnostics: (fp: string) => {
          expect(fp).toBe(fileAbs);
          return [
            {
              range: { start: { line: 9, character: 4 }, end: { line: 9, character: 10 } },
              severity: 1,
              message: 'Type mismatch',
              source: 'tsserver',
            },
            {
              range: { start: { line: 19, character: 0 }, end: { line: 19, character: 5 } },
              severity: 2,
              message: 'Unused import',
              source: 'tsserver',
            },
            // hint should be filtered out by 'all'
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 4,
              message: 'A hint',
            },
          ];
        },
        getDiagnostics: () => new Map(),
      });
      const result = await run({ file_path: 'src/foo.ts' }, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Diagnostics for src/foo.ts: 1 error, 1 warning');
        expect(result.output).toContain('Error L10:5: Type mismatch [tsserver]');
        expect(result.output).toContain('Warning L20:1: Unused import [tsserver]');
        expect(result.output).not.toContain('A hint');
        expect(result.meta).toEqual({ errorCount: 1, warningCount: 1, scope: 'src/foo.ts' });
      }
    });

    it('filters by severity error', async () => {
      getLSPManagerMock.mockReturnValue({
        getFileDiagnostics: () => [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: 1,
            message: 'E',
          },
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
            severity: 2,
            message: 'W',
          },
        ],
        getDiagnostics: () => new Map(),
      });
      const result = await run({ file_path: 'a.ts', severity_filter: 'error' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('1 error');
        expect(result.output).not.toContain('Warning');
      }
    });

    it('formats project-wide diagnostics grouped by file', async () => {
      const ctx = makeCtx();
      const fileA = path.join(ctx.workingDir, 'a.ts');
      const fileB = path.join(ctx.workingDir, 'b.ts');
      const all = new Map<string, any[]>([
        [
          pathToFileURL(fileA).href,
          [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
              message: 'EA',
              source: 'ts',
            },
          ],
        ],
        [
          pathToFileURL(fileB).href,
          [
            {
              range: { start: { line: 4, character: 2 }, end: { line: 4, character: 3 } },
              severity: 2,
              message: 'WB',
            },
          ],
        ],
      ]);
      getLSPManagerMock.mockReturnValue({
        getFileDiagnostics: () => [],
        getDiagnostics: () => all,
      });
      const result = await run({}, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Diagnostics for project: 1 error, 1 warning');
        expect(result.output).toContain('a.ts:');
        expect(result.output).toContain('Error L1:1: EA [ts]');
        expect(result.output).toContain('b.ts:');
        expect(result.output).toContain('Warning L5:3: WB');
      }
    });

    it('emits starting and completing progress', async () => {
      getLSPManagerMock.mockReturnValue({
        getFileDiagnostics: () => [],
        getDiagnostics: () => new Map(),
      });
      const onProgress = vi.fn();
      await run({}, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});

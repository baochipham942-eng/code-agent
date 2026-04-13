// ============================================================================
// mermaid_export (native ToolModule) Tests — P0-6.3 Batch 7
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mock fs and fetch
// -----------------------------------------------------------------------------

const writeFileSyncMock = vi.fn();
const existsSyncMock = vi.fn().mockReturnValue(true);
const mkdirSyncMock = vi.fn();
const statSyncMock = vi.fn().mockReturnValue({ size: 2048 });

vi.mock('fs', () => ({
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { mermaidExportModule } from '../../../../../src/main/tools/modules/network/mermaidExport';

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
    workingDir: '/tmp/work',
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
  const handler = await mermaidExportModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

function makeFetchOk() {
  const buf = new ArrayBuffer(32);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf,
    text: async () => '',
  };
}

beforeEach(() => {
  writeFileSyncMock.mockReset();
  existsSyncMock.mockReset().mockReturnValue(true);
  mkdirSyncMock.mockReset();
  statSyncMock.mockReset().mockReturnValue({ size: 2048 });
  fetchMock.mockReset();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('mermaidExportModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(mermaidExportModule.schema.name).toBe('mermaid_export');
      expect(mermaidExportModule.schema.category).toBe('network');
      expect(mermaidExportModule.schema.permissionLevel).toBe('write');
      expect(mermaidExportModule.schema.readOnly).toBe(false);
      expect(mermaidExportModule.schema.allowInPlanMode).toBe(false);
      expect(mermaidExportModule.schema.inputSchema.required).toEqual(['code']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing code', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty code string', async () => {
      const result = await run({ code: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects invalid format', async () => {
      const result = await run({ code: 'graph TD\nA-->B', format: 'jpeg' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects invalid theme', async () => {
      const result = await run({ code: 'graph TD\nA-->B', theme: 'rainbow' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ code: 'graph TD\nA-->B' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ code: 'graph TD\nA-->B' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('wraps mermaid syntax errors with friendly hint', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => 'syntax error in input',
      });
      const result = await run({ code: 'graph TD\nbroken' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Mermaid 语法错误');
    });
  });

  describe('happy paths', () => {
    it('exports png with default theme', async () => {
      fetchMock.mockResolvedValue(makeFetchOk());
      const result = await run({ code: 'graph TD\nA-->B' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Mermaid 图表已导出');
        expect(result.output).toContain('流程图');
        expect(result.output).toContain('PNG');
        const meta = result.meta as Record<string, unknown>;
        expect(meta.format).toBe('png');
        expect(meta.chartType).toBe('流程图');
      }
      expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    });

    it('detects sequenceDiagram as 时序图', async () => {
      fetchMock.mockResolvedValue(makeFetchOk());
      const result = await run({ code: 'sequenceDiagram\nA->>B: Hi' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('时序图');
    });

    it('svg format hits svg endpoint', async () => {
      fetchMock.mockResolvedValue(makeFetchOk());
      await run({ code: 'graph TD\nA-->B', format: 'svg' });
      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain('/svg/');
    });

    it('transparent background omits bgColor query', async () => {
      fetchMock.mockResolvedValue(makeFetchOk());
      await run({ code: 'graph TD\nA-->B' }); // default background = transparent
      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).not.toContain('bgColor=');
    });

    it('custom background adds bgColor query', async () => {
      fetchMock.mockResolvedValue(makeFetchOk());
      await run({ code: 'graph TD\nA-->B', background: 'white' });
      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain('bgColor=white');
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      fetchMock.mockResolvedValue(makeFetchOk());
      const onProgress = vi.fn();
      await run({ code: 'graph TD\nA-->B' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});

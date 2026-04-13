// ============================================================================
// chart_generate (native ToolModule) Tests — P0-6.3 Batch 7
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
const statSyncMock = vi.fn().mockReturnValue({ size: 4096 });

vi.mock('fs', () => ({
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { chartGenerateModule } from '../../../../../src/main/tools/migrated/network/chartGenerate';

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
  const handler = await chartGenerateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

function makeFetchOk() {
  const buf = new ArrayBuffer(64);
  return { ok: true, status: 200, arrayBuffer: async () => buf };
}

beforeEach(() => {
  writeFileSyncMock.mockReset();
  existsSyncMock.mockReset().mockReturnValue(true);
  mkdirSyncMock.mockReset();
  statSyncMock.mockReset().mockReturnValue({ size: 4096 });
  fetchMock.mockReset();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('chartGenerateModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(chartGenerateModule.schema.name).toBe('chart_generate');
      expect(chartGenerateModule.schema.category).toBe('network');
      expect(chartGenerateModule.schema.permissionLevel).toBe('write');
      expect(chartGenerateModule.schema.readOnly).toBe(false);
      expect(chartGenerateModule.schema.allowInPlanMode).toBe(false);
      expect(chartGenerateModule.schema.inputSchema.required).toEqual([
        'type',
        'labels',
        'datasets',
      ]);
    });
  });

  describe('validation & errors', () => {
    it('rejects invalid type', async () => {
      const result = await run({ type: 'not_a_type', labels: [], datasets: [{ data: [] }] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects non-array labels', async () => {
      const result = await run({ type: 'bar', labels: 'oops', datasets: [{ data: [1] }] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty datasets', async () => {
      const result = await run({ type: 'bar', labels: ['a'], datasets: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run(
        { type: 'bar', labels: ['a'], datasets: [{ data: [1] }] },
        makeCtx(),
        denyAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run(
        { type: 'bar', labels: ['a'], datasets: [{ data: [1] }] },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns error when QuickChart fetch fails', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        arrayBuffer: async () => new ArrayBuffer(0),
      });
      const result = await run({
        type: 'bar',
        labels: ['a'],
        datasets: [{ data: [1] }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('QuickChart API 错误');
    });
  });

  describe('happy paths', () => {
    it('generates a bar chart and writes file', async () => {
      fetchMock.mockResolvedValue(makeFetchOk());
      const result = await run({
        type: 'bar',
        title: 'Sales',
        labels: ['Jan', 'Feb'],
        datasets: [{ label: 'Rev', data: [1, 2] }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('图表已生成');
        expect(result.output).toContain('bar');
        expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
        const meta = result.meta as Record<string, unknown>;
        expect(meta.chartType).toBe('bar');
        const renderSpec = meta.renderSpec as Record<string, unknown>;
        expect(renderSpec.type).toBe('bar');
        expect(renderSpec.xKey).toBe('label');
        expect(Array.isArray(renderSpec.series)).toBe(true);
      }
    });

    it('pie chart renderSpec uses {name,value} format', async () => {
      fetchMock.mockResolvedValue(makeFetchOk());
      const result = await run({
        type: 'pie',
        labels: ['A', 'B', 'C'],
        datasets: [{ data: [10, 20, 30] }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.meta as Record<string, unknown>;
        const renderSpec = meta.renderSpec as Record<string, unknown>;
        expect(renderSpec.type).toBe('pie');
        const data = renderSpec.data as Array<{ name: string; value: number }>;
        expect(data).toEqual([
          { name: 'A', value: 10 },
          { name: 'B', value: 20 },
          { name: 'C', value: 30 },
        ]);
      }
    });

    it('creates output dir when missing', async () => {
      fetchMock.mockResolvedValue(makeFetchOk());
      existsSyncMock.mockReturnValue(false);
      const result = await run({
        type: 'line',
        labels: ['x'],
        datasets: [{ data: [1] }],
      });
      expect(result.ok).toBe(true);
      expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      fetchMock.mockResolvedValue(makeFetchOk());
      const onProgress = vi.fn();
      await run(
        { type: 'bar', labels: ['a'], datasets: [{ data: [1] }] },
        makeCtx(),
        allowAll,
        onProgress,
      );
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});

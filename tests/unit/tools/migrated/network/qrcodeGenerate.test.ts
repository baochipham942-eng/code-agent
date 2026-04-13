// ============================================================================
// qrcode_generate (native ToolModule) Tests — P0-6.3 Batch 7
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mock fs and qrcode
// -----------------------------------------------------------------------------

const writeFileSyncMock = vi.fn();
const existsSyncMock = vi.fn().mockReturnValue(true);
const mkdirSyncMock = vi.fn();
const statSyncMock = vi.fn().mockReturnValue({ size: 1024 });

vi.mock('fs', () => ({
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
}));

const toFileMock = vi.fn().mockResolvedValue(undefined);
vi.mock('qrcode', () => ({
  default: { toFile: (...args: unknown[]) => toFileMock(...args) },
  toFile: (...args: unknown[]) => toFileMock(...args),
}));

import { qrcodeGenerateModule } from '../../../../../src/main/tools/migrated/network/qrcodeGenerate';

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
  const handler = await qrcodeGenerateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  writeFileSyncMock.mockReset();
  existsSyncMock.mockReset().mockReturnValue(true);
  mkdirSyncMock.mockReset();
  statSyncMock.mockReset().mockReturnValue({ size: 1024 });
  toFileMock.mockReset().mockResolvedValue(undefined);
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('qrcodeGenerateModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(qrcodeGenerateModule.schema.name).toBe('qrcode_generate');
      expect(qrcodeGenerateModule.schema.category).toBe('network');
      expect(qrcodeGenerateModule.schema.permissionLevel).toBe('write');
      expect(qrcodeGenerateModule.schema.readOnly).toBe(false);
      expect(qrcodeGenerateModule.schema.allowInPlanMode).toBe(false);
      expect(qrcodeGenerateModule.schema.inputSchema.required).toEqual(['content']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing content', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty content', async () => {
      const result = await run({ content: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ content: 'hello' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ content: 'hello' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('content type detection', () => {
    it('detects URL', async () => {
      const result = await run({ content: 'https://example.com' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('类型: URL');
        const meta = result.meta as Record<string, unknown>;
        expect(meta.contentType).toBe('URL');
      }
    });

    it('detects WiFi', async () => {
      const result = await run({ content: 'WIFI:T:WPA;S:Net;P:pwd;;' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('类型: WiFi');
    });

    it('detects 电话', async () => {
      const result = await run({ content: 'tel:+8613800001111' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('类型: 电话');
    });

    it('detects 名片', async () => {
      const result = await run({
        content: 'BEGIN:VCARD\nVERSION:3.0\nFN:Lin\nEND:VCARD',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('类型: 名片');
    });

    it('falls back to 文本 for plain string', async () => {
      const result = await run({ content: 'hello world' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toContain('类型: 文本');
    });
  });

  describe('option passthrough', () => {
    it('passes size, color, background, margin to qrcode.toFile', async () => {
      await run({
        content: 'https://example.com',
        size: 512,
        color: '#1a365d',
        background: '#fafafa',
        margin: 8,
      });
      expect(toFileMock).toHaveBeenCalledTimes(1);
      const opts = toFileMock.mock.calls[0][2] as {
        width: number;
        margin: number;
        color: { dark: string; light: string };
      };
      expect(opts.width).toBe(512);
      expect(opts.margin).toBe(8);
      expect(opts.color.dark).toBe('#1a365d');
      expect(opts.color.light).toBe('#fafafa');
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      const onProgress = vi.fn();
      await run({ content: 'hi' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});

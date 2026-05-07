// ============================================================================
// pdf_compress (native ToolModule) Tests — P1 Wave 4 D2b
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const {
  existsSyncMock,
  mkdirSyncMock,
  statSyncMock,
  renameSyncMock,
  unlinkSyncMock,
  execFileMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  renameSyncMock: vi.fn(),
  unlinkSyncMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
  renameSync: (...args: unknown[]) => renameSyncMock(...args),
  unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
}));

vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock('util', () => ({
  promisify: () => (...args: unknown[]) => {
    return new Promise((resolve, reject) => {
      execFileMock(...args, (err: unknown, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  },
}));

import { pdfCompressModule } from '../../../../../src/main/tools/modules/network/pdfCompress';

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
  const handler = await pdfCompressModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

/**
 * Default execFile behaviour:
 *  - Any call with `--version` returns version 9.55.0 (gs found)
 *  - Any call with `-sDEVICE=pdfwrite` resolves successfully
 */
function setupExecOk() {
  execFileMock.mockImplementation((cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    if (typeof cb === 'function') {
      (cb as (err: unknown, stdout: string, stderr: string) => void)(null, 'ok', '');
    }
  });
}

beforeEach(() => {
  existsSyncMock.mockReset().mockReturnValue(true);
  mkdirSyncMock.mockReset();
  statSyncMock.mockReset().mockImplementation((p: string) => {
    // pre-compress = 100KB, post-compress = 50KB
    return p.includes('_compressed') || !p.endsWith('.pdf') || p.endsWith('.tmp')
      ? { size: 50 * 1024 }
      : { size: 100 * 1024 };
  });
  renameSyncMock.mockReset();
  unlinkSyncMock.mockReset();
  execFileMock.mockReset();
  setupExecOk();
});

describe('pdfCompressModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(pdfCompressModule.schema.name).toBe('pdf_compress');
      expect(pdfCompressModule.schema.category).toBe('network');
      expect(pdfCompressModule.schema.permissionLevel).toBe('write');
      expect(pdfCompressModule.schema.inputSchema.required).toEqual(['input_path']);
    });

    it('exposes 4 quality levels via enum', () => {
      const qProp = (pdfCompressModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>).quality;
      expect(qProp.enum).toEqual(['screen', 'ebook', 'printer', 'prepress']);
    });
  });

  describe('validation & error gates', () => {
    it('rejects missing input_path', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects invalid quality', async () => {
      const result = await run({ input_path: 'a.pdf', quality: 'foo' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ input_path: 'a.pdf' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await run({ input_path: 'a.pdf' }, makeCtx({ abortSignal: ctrl.signal }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('errors when input file missing', async () => {
      existsSyncMock.mockImplementation((p: string) => !p.endsWith('a.pdf'));
      const result = await run({ input_path: 'a.pdf' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('文件不存在');
    });

    it('errors on non-pdf extension', async () => {
      const result = await run({ input_path: 'a.txt' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('不是 PDF 文件');
    });

    it('errors when ghostscript not found', async () => {
      // Make all gs lookups fail
      execFileMock.mockImplementation(
        (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
          const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
          if (typeof cb === 'function') {
            (cb as (err: unknown) => void)(new Error('not found'));
          }
        },
      );
      const result = await run({ input_path: 'a.pdf' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('未找到 Ghostscript');
    });
  });

  describe('happy path', () => {
    it('compresses with default ebook quality', async () => {
      const result = await run({ input_path: '/tmp/work/a.pdf' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('PDF 压缩完成');
        expect(result.output).toContain('减少 50.0%');
        const meta = result.meta as Record<string, unknown>;
        expect(meta.quality).toBe('ebook');
        expect(meta.compressionRatio).toBe(50);
        expect(meta.artifact).toMatchObject({
          kind: 'document',
          sourceTool: 'pdf_compress',
          path: '/tmp/work/a_compressed.pdf',
          mimeType: 'application/pdf',
          metadata: {
            inputPath: '/tmp/work/a.pdf',
            quality: 'ebook',
            compressionRatio: 50,
          },
        });
        expect(meta.outputPath).toBe('/tmp/work/a_compressed.pdf');
        expect(meta.contentLength).toBe(50 * 1024);
        expect(meta.truncated).toBe(false);
        const att = meta.attachment as Record<string, string>;
        expect(att.mimeType).toBe('application/pdf');
        expect(att.category).toBe('document');
      }
      expect(renameSyncMock).toHaveBeenCalledTimes(1);
    });

    it('honors all 4 quality levels', async () => {
      for (const q of ['screen', 'ebook', 'printer', 'prepress']) {
        const result = await run({ input_path: '/tmp/work/a.pdf', quality: q });
        expect(result.ok).toBe(true);
        if (result.ok) {
          const meta = result.meta as Record<string, unknown>;
          expect(meta.quality).toBe(q);
        }
      }
    });

    it('uses custom output_path when provided', async () => {
      await run({ input_path: '/tmp/work/a.pdf', output_path: 'mini.pdf' });
      // tmp file rename target should match resolved output_path
      const renameTarget = renameSyncMock.mock.calls[0][1] as string;
      expect(renameTarget).toBe('/tmp/work/mini.pdf');
    });

    it('returns warning when compressed file is bigger', async () => {
      // After compress, "new" file is bigger than original
      statSyncMock.mockImplementation((p: string) => {
        if (p.endsWith('.tmp') || p.includes('_compressed')) return { size: 200 * 1024 };
        return { size: 100 * 1024 };
      });
      const result = await run({ input_path: '/tmp/work/a.pdf' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已经是最优状态');
        const meta = result.meta as Record<string, unknown>;
        expect(meta.compressionRatio).toBe(0);
        expect(meta.artifact).toMatchObject({
          kind: 'document',
          sourceTool: 'pdf_compress',
          mimeType: 'application/pdf',
          contentLength: 100 * 1024,
          metadata: { optimized: true },
        });
      }
      expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('returns failure when ghostscript exec fails', async () => {
      // First call (--version) succeeds, second (compress) fails
      let callCount = 0;
      execFileMock.mockImplementation((cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
        callCount++;
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
        if (typeof cb !== 'function') return;
        if (args.includes('--version')) {
          (cb as (err: unknown, stdout: string, stderr: string) => void)(null, '9.55.0', '');
        } else {
          (cb as (err: unknown) => void)(new Error('gs crashed'));
        }
      });
      const result = await run({ input_path: '/tmp/work/a.pdf' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('gs crashed');
      expect(callCount).toBeGreaterThan(0);
    });
  });

  describe('onProgress', () => {
    it('emits starting and completing stages', async () => {
      const onProgress = vi.fn();
      await run({ input_path: '/tmp/work/a.pdf' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});

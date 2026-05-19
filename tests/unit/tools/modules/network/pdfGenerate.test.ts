// ============================================================================
// pdf_generate (native ToolModule) Tests — P1 Wave 4 D2b
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';
import { EventEmitter } from 'events';

const { existsSyncMock, mkdirSyncMock, statSyncMock, createWriteStreamMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  statSyncMock: vi.fn().mockReturnValue({ size: 2048 }),
  createWriteStreamMock: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  statSync: (...args: unknown[]) => statSyncMock(...args),
  createWriteStream: (...args: unknown[]) => createWriteStreamMock(...args),
}));

const { pdfDocCtorMock } = vi.hoisted(() => ({
  pdfDocCtorMock: vi.fn(),
}));

vi.mock('pdfkit', () => {
  class FakePDFDocument {
    y = 0;
    constructor(opts: unknown) {
      pdfDocCtorMock(opts);
    }
    pipe(_stream: unknown) {
      return this;
    }
    font(_f: string) {
      return this;
    }
    fontSize(_s: number) {
      return this;
    }
    fillColor(_c: string) {
      return this;
    }
    text(_t: string, _opts?: unknown) {
      return this;
    }
    moveDown(_n?: number) {
      return this;
    }
    addPage() {
      return this;
    }
    bufferedPageRange() {
      return { count: 1 };
    }
    end() {
      return this;
    }
  }
  return { default: FakePDFDocument };
});

import { pdfGenerateModule } from '../../../../../src/main/tools/modules/network/pdfGenerate';

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
  const handler = await pdfGenerateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  existsSyncMock.mockReset().mockReturnValue(true);
  mkdirSyncMock.mockReset();
  statSyncMock.mockReset().mockReturnValue({ size: 2048 });
  createWriteStreamMock.mockReset().mockImplementation(() => {
    const ee = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
    ee.write = () => undefined;
    ee.end = () => undefined;
    setImmediate(() => ee.emit('finish'));
    return ee;
  });
  pdfDocCtorMock.mockReset();
});

describe('pdfGenerateModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(pdfGenerateModule.schema.name).toBe('pdf_generate');
      expect(pdfGenerateModule.schema.category).toBe('network');
      expect(pdfGenerateModule.schema.permissionLevel).toBe('write');
      expect(pdfGenerateModule.schema.inputSchema.required).toEqual(['title', 'content']);
    });

    it('exposes 3 themes and 3 page sizes', () => {
      const props = pdfGenerateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>;
      expect(props.theme.enum).toEqual(['default', 'academic', 'minimal']);
      expect(props.page_size.enum).toEqual(['A4', 'Letter', 'Legal']);
    });
  });

  describe('validation & error gates', () => {
    it('rejects missing title', async () => {
      const result = await run({ content: 'body' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing content', async () => {
      const result = await run({ title: 'T' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ title: 'T', content: 'x' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await run({ title: 'T', content: 'x' }, makeCtx({ abortSignal: ctrl.signal }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('happy path', () => {
    it('writes pdf with default theme + A4 + Agent Neo author', async () => {
      const result = await run({ title: '报告', content: '# H1\nbody' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('PDF 文档已生成');
        expect(result.output).toContain('A4');
        const meta = result.meta as Record<string, unknown>;
        expect(meta.theme).toBe('default');
        expect(meta.pageSize).toBe('A4');
        expect(meta.fileSize).toBe(2048);
        expect(meta.artifact).toMatchObject({
          kind: 'document',
          sourceTool: 'pdf_generate',
          path: '/tmp/work/报告.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 2048,
          metadata: {
            title: '报告',
            pageCount: 1,
            theme: 'default',
            pageSize: 'A4',
          },
        });
        const att = meta.attachment as Record<string, string | number>;
        expect(att.mimeType).toBe('application/pdf');
        expect(att.category).toBe('document');
        expect(String(att.id).startsWith('pdf-')).toBe(true);
      }
      expect(pdfDocCtorMock).toHaveBeenCalledTimes(1);
      const opts = pdfDocCtorMock.mock.calls[0][0] as { info: { Title: string; Author: string } };
      expect(opts.info.Title).toBe('报告');
      expect(opts.info.Author).toBe('Agent Neo');
    });

    it('respects custom output_path', async () => {
      await run({ title: 'T', content: 'x', output_path: '/tmp/work/x.pdf' });
      expect(createWriteStreamMock).toHaveBeenCalledWith('/tmp/work/x.pdf');
    });

    it('creates output directory if missing', async () => {
      existsSyncMock.mockReturnValue(false);
      await run({ title: 'T', content: 'x' });
      expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
    });

    it('honors all 3 themes', async () => {
      for (const theme of ['default', 'academic', 'minimal']) {
        const result = await run({ title: 'T', content: 'x', theme });
        expect(result.ok).toBe(true);
        if (result.ok) {
          const meta = result.meta as Record<string, unknown>;
          expect(meta.theme).toBe(theme);
        }
      }
    });

    it('honors all 3 page sizes', async () => {
      for (const page_size of ['A4', 'Letter', 'Legal']) {
        const result = await run({ title: 'T', content: 'x', page_size });
        expect(result.ok).toBe(true);
        if (result.ok) {
          const meta = result.meta as Record<string, unknown>;
          expect(meta.pageSize).toBe(page_size);
        }
      }
    });

    it('passes author to PDFDocument info', async () => {
      await run({ title: 'T', content: 'x', author: '林晨' });
      const opts = pdfDocCtorMock.mock.calls[0][0] as { info: { Author: string } };
      expect(opts.info.Author).toBe('林晨');
    });
  });

  describe('markdown rendering (smoke)', () => {
    it('handles complex markdown without throwing', async () => {
      const md = [
        '# Title',
        '## Heading',
        '### Sub',
        'Paragraph text.',
        '- list1',
        '- list2',
        '1. ordered',
        '> quote',
        '```',
        'code',
        '```',
      ].join('\n');
      const result = await run({ title: 'T', content: md });
      expect(result.ok).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns failure when stream errors', async () => {
      createWriteStreamMock.mockImplementationOnce(() => {
        const ee = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
        ee.write = () => undefined;
        ee.end = () => undefined;
        setImmediate(() => ee.emit('error', new Error('disk full')));
        return ee;
      });
      const result = await run({ title: 'T', content: 'x' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('disk full');
    });
  });

  describe('onProgress', () => {
    it('emits starting and completing stages', async () => {
      const onProgress = vi.fn();
      await run({ title: 'T', content: 'x' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});

// ============================================================================
// docx_generate (native ToolModule) Tests — P1 Wave 4 D2b
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

const packerToBufferMock = vi.fn().mockResolvedValue(Buffer.from('docx-content'));
vi.mock('docx', async () => {
  const actual = await vi.importActual<typeof import('docx')>('docx');
  return {
    ...actual,
    Packer: { toBuffer: (...args: unknown[]) => packerToBufferMock(...args) },
  };
});

import { docxGenerateModule } from '../../../../../src/main/tools/modules/network/docxGenerate';

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
  const handler = await docxGenerateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  writeFileSyncMock.mockReset();
  existsSyncMock.mockReset().mockReturnValue(true);
  mkdirSyncMock.mockReset();
  statSyncMock.mockReset().mockReturnValue({ size: 4096 });
  packerToBufferMock.mockReset().mockResolvedValue(Buffer.from('docx-content'));
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('docxGenerateModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(docxGenerateModule.schema.name).toBe('docx_generate');
      expect(docxGenerateModule.schema.category).toBe('network');
      expect(docxGenerateModule.schema.permissionLevel).toBe('write');
      expect(docxGenerateModule.schema.readOnly).toBe(false);
      expect(docxGenerateModule.schema.allowInPlanMode).toBe(false);
      expect(docxGenerateModule.schema.inputSchema.required).toEqual(['title', 'content']);
    });

    it('exposes 4 themes via enum', () => {
      const themeProp = (docxGenerateModule.schema.inputSchema.properties as Record<string, { enum?: string[] }>).theme;
      expect(themeProp.enum).toEqual(['professional', 'academic', 'minimal', 'creative']);
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

    it('rejects empty title', async () => {
      const result = await run({ title: '', content: 'body' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ title: 'T', content: 'body' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ title: 'T', content: 'body' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('happy path', () => {
    it('writes docx with default theme + Agent Neo author', async () => {
      const result = await run({ title: '报告', content: '# 标题\n正文' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Word 文档已生成');
        expect(result.output).toContain('professional');
        const meta = result.meta as Record<string, unknown>;
        expect(meta.theme).toBe('professional');
        expect(meta.fileSize).toBe(4096);
        expect(meta.artifact).toMatchObject({
          kind: 'document',
          sourceTool: 'docx_generate',
          path: expect.stringMatching(/^\/tmp\/work\/document-\d+\.docx$/),
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 4096,
          metadata: {
            title: '报告',
            theme: 'professional',
            author: 'Agent Neo',
          },
        });
        const att = meta.attachment as Record<string, string | number>;
        expect(att.mimeType).toBe(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        );
        expect(att.category).toBe('document');
        expect(String(att.id).startsWith('docx-')).toBe(true);
      }
      expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
      expect(packerToBufferMock).toHaveBeenCalledTimes(1);
    });

    it('respects custom output_path', async () => {
      const result = await run({
        title: 'T',
        content: 'body',
        output_path: '/tmp/work/custom.docx',
      });
      expect(result.ok).toBe(true);
      const callPath = writeFileSyncMock.mock.calls[0][0] as string;
      expect(callPath).toBe('/tmp/work/custom.docx');
    });

    it('creates output directory if missing', async () => {
      existsSyncMock.mockReturnValue(false);
      await run({ title: 'T', content: 'body' });
      expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
      expect(mkdirSyncMock.mock.calls[0][1]).toEqual({ recursive: true });
    });

    it('honors all 4 themes', async () => {
      for (const theme of ['professional', 'academic', 'minimal', 'creative']) {
        writeFileSyncMock.mockClear();
        const result = await run({ title: 'T', content: 'body', theme });
        expect(result.ok).toBe(true);
        if (result.ok) {
          const meta = result.meta as Record<string, unknown>;
          expect(meta.theme).toBe(theme);
        }
      }
    });
  });

  describe('markdown rendering (smoke)', () => {
    it('handles complex markdown without throwing', async () => {
      const md = [
        '# H1',
        '## H2',
        '### H3',
        '- list',
        '1. ordered',
        '> quote',
        '**bold** *italic* `code`',
        '```',
        'code block',
        '```',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
      ].join('\n');
      const result = await run({ title: 'T', content: md });
      expect(result.ok).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns failure when Packer.toBuffer throws', async () => {
      packerToBufferMock.mockRejectedValueOnce(new Error('docx-fail'));
      const result = await run({ title: 'T', content: 'body' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('docx-fail');
    });
  });

  describe('onProgress', () => {
    it('emits starting and completing stages', async () => {
      const onProgress = vi.fn();
      await run({ title: 'T', content: 'body' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});

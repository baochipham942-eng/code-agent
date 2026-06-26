import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';

const clipboardMock = vi.hoisted(() => ({
  availableFormats: vi.fn<() => string[]>(),
  readText: vi.fn<() => string>(),
  readHTML: vi.fn<() => string>(),
  readImage: vi.fn<() => {
    isEmpty: () => boolean;
    getSize: () => { width: number; height: number };
    toPNG: () => Buffer;
  }>(),
}));

vi.mock('../../../../../src/host/platform', () => ({
  clipboard: clipboardMock,
}));

import { readClipboardModule } from '../../../../../src/host/tools/modules/file/readClipboard';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

async function run(args: Record<string, unknown>, ctx: ToolContext = makeCtx()) {
  const handler = await readClipboardModule.createHandler();
  return handler.execute(args, ctx, allowAll);
}

beforeEach(() => {
  clipboardMock.availableFormats.mockReset();
  clipboardMock.readText.mockReset();
  clipboardMock.readHTML.mockReset();
  clipboardMock.readImage.mockReset();
});

describe('readClipboardModule artifact metadata', () => {
  it('returns text clipboard content with a text artifact', async () => {
    clipboardMock.availableFormats.mockReturnValue(['public.utf8-plain-text']);
    clipboardMock.readText.mockReturnValue('hello clipboard');

    const result = await run({ format: 'auto' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('hello clipboard');
      expect(result.meta).toMatchObject({
        kind: 'text',
        format: 'text',
        contentLength: 'hello clipboard'.length,
        truncated: false,
      });
      expect(result.meta?.artifact).toMatchObject({
        kind: 'text',
        sourceTool: 'read_clipboard',
        mimeType: 'text/plain',
        metadata: expect.objectContaining({
          source: 'clipboard',
          format: 'text',
        }),
      });
    }
  });

  it('returns image clipboard content with an image artifact', async () => {
    clipboardMock.availableFormats.mockReturnValue(['public.png']);
    clipboardMock.readImage.mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 3 }),
      toPNG: () => Buffer.from('png'),
    });

    const result = await run({ format: 'image' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('[Clipboard Image]');
      expect(result.meta).toMatchObject({
        kind: 'image',
        format: 'image',
        width: 2,
        height: 3,
        bytes: 3,
      });
      expect(result.meta?.artifact).toMatchObject({
        kind: 'image',
        sourceTool: 'read_clipboard',
        mimeType: 'image/png',
      });
    }
  });
});

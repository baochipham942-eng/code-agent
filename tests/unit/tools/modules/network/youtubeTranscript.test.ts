// ============================================================================
// youtube_transcript (native ToolModule) Tests — P0-6.3 Batch 9
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

import { youtubeTranscriptModule } from '../../../../../src/main/tools/modules/network/youtubeTranscript';

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
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await youtubeTranscriptModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.SUPADATA_API_KEY = 'test-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPADATA_API_KEY;
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

const SUPADATA_OK = {
  content: [
    { text: 'Hello world.', offset: 0, duration: 2000, lang: 'en' },
    { text: 'Second segment.', offset: 2000, duration: 3000, lang: 'en' },
  ],
  lang: 'en',
  availableLangs: ['en', 'zh'],
};

describe('youtubeTranscriptModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(youtubeTranscriptModule.schema.name).toBe('youtube_transcript');
      expect(youtubeTranscriptModule.schema.category).toBe('network');
      expect(youtubeTranscriptModule.schema.permissionLevel).toBe('network');
      expect(youtubeTranscriptModule.schema.readOnly).toBe(true);
      expect(youtubeTranscriptModule.schema.allowInPlanMode).toBe(true);
      expect(youtubeTranscriptModule.schema.inputSchema.required).toEqual(['url']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing url', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ url: VIDEO_URL }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ url: VIDEO_URL }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('rejects invalid YouTube URL', async () => {
      const result = await run({ url: 'https://example.com/foo' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('happy paths', () => {
    it('Supadata happy path with timestamps', async () => {
      // First call: oembed video info
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ title: 'Rick Astley', author_name: 'RA Channel' }),
      );
      // Second call: Supadata transcript
      fetchMock.mockResolvedValueOnce(jsonResponse(SUPADATA_OK));

      const result = await run({ url: VIDEO_URL });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Rick Astley');
        expect(result.output).toContain('Hello world');
        expect(result.output).toContain('Second segment');
        expect(result.output).toMatch(/\[\d+:\d{2}\]/); // timestamp format
      }
    });

    it('text_only mode omits timestamps', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ title: 'T', author_name: 'A' }));
      fetchMock.mockResolvedValueOnce(jsonResponse(SUPADATA_OK));

      const result = await run({ url: VIDEO_URL, text_only: true });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Hello world');
        expect(result.output).not.toMatch(/\[\d+:\d{2}\]/);
      }
    });

    it('passes language param to Supadata API', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ title: 'T', author_name: 'A' }));
      fetchMock.mockResolvedValueOnce(jsonResponse(SUPADATA_OK));

      await run({ url: VIDEO_URL, language: 'zh' });
      // The 2nd call should be supadata with lang=zh
      const supadataCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('supadata'),
      );
      expect(supadataCall).toBeDefined();
      expect(String(supadataCall![0])).toContain('lang=zh');
    });

    it('falls back when Supadata fails', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ title: 'T', author_name: 'A' }));
      // Supadata fails
      fetchMock.mockResolvedValueOnce(jsonResponse('forbidden', 403));
      // Fallback API responds
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              transcript: {
                content: [
                  { text: 'Fallback text', start: '0', duration: '5' },
                ],
              },
            },
          ],
        }),
      );

      const result = await run({ url: VIDEO_URL });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Fallback text');
      }
    });

    it('returns NETWORK_ERROR when all APIs fail', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ title: 'T', author_name: 'A' }));
      // Supadata fails
      fetchMock.mockResolvedValueOnce(jsonResponse('boom', 500));
      // Fallback fails
      fetchMock.mockResolvedValueOnce(jsonResponse('boom', 500));

      const result = await run({ url: VIDEO_URL });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NETWORK_ERROR');
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ title: 'T', author_name: 'A' }));
      fetchMock.mockResolvedValueOnce(jsonResponse(SUPADATA_OK));
      const onProgress = vi.fn();
      await run({ url: VIDEO_URL }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});

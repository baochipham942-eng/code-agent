// ============================================================================
// twitter_fetch (native ToolModule) Tests — P0-6.3 Batch 9
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

import { twitterFetchModule } from '../../../../../src/main/tools/migrated/network/twitterFetch';

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
  const handler = await twitterFetchModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function textResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => ({}),
  } as unknown as Response;
}

const TWEET_URL = 'https://twitter.com/elonmusk/status/1234567890';

describe('twitterFetchModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(twitterFetchModule.schema.name).toBe('twitter_fetch');
      expect(twitterFetchModule.schema.category).toBe('network');
      expect(twitterFetchModule.schema.permissionLevel).toBe('network');
      expect(twitterFetchModule.schema.readOnly).toBe(true);
      expect(twitterFetchModule.schema.allowInPlanMode).toBe(true);
      expect(twitterFetchModule.schema.inputSchema.required).toEqual(['url']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing url', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty url', async () => {
      const result = await run({ url: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ url: TWEET_URL }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ url: TWEET_URL }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('rejects invalid tweet URL format', async () => {
      const result = await run({ url: 'https://example.com/foo' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('happy paths', () => {
    it('FxTwitter happy path', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          tweet: {
            text: 'Hello world tweet',
            author: { name: 'Elon Musk', screen_name: 'elonmusk' },
            created_at: '2025-01-01',
            likes: 100,
            retweets: 20,
            replies: 5,
            media: { all: [{ url: 'https://img/1.jpg' }] },
          },
        }),
      );

      const result = await run({ url: TWEET_URL });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Hello world tweet');
        expect(result.output).toContain('Elon Musk');
        expect(result.output).toContain('@elonmusk');
        expect(result.output).toContain('https://img/1.jpg');
      }
    });

    it('falls back to VxTwitter when FxTwitter fails', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse('err', 500)); // FxTwitter fail
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          user_name: 'Elon',
          user_screen_name: 'elonmusk',
          text: 'Vx tweet text',
          date: '2025-01-01',
          likes: 10,
          retweets: 1,
          replies: 0,
          media_urls: [],
        }),
      );

      const result = await run({ url: TWEET_URL });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Vx tweet text');
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to Nitter when both APIs fail', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse('err', 500));
      fetchMock.mockResolvedValueOnce(jsonResponse('err', 500));
      // Nitter returns HTML
      const html =
        '<a class="fullname">Elon Musk</a><div class="tweet-content media-body">Nitter fallback text</div>';
      fetchMock.mockResolvedValueOnce(textResponse(html));

      const result = await run({ url: TWEET_URL });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Nitter fallback text');
      }
    });

    it('all sources fail returns NETWORK_ERROR', async () => {
      // 2 API + 3 Nitter instances
      for (let i = 0; i < 5; i++) {
        fetchMock.mockResolvedValueOnce(jsonResponse('err', 500));
      }
      const result = await run({ url: TWEET_URL });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NETWORK_ERROR');
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          tweet: {
            text: 't',
            author: { name: 'a', screen_name: 'a' },
          },
        }),
      );
      const onProgress = vi.fn();
      await run({ url: TWEET_URL }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});

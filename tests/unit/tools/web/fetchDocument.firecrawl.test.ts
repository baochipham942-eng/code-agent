import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_API_ENDPOINTS } from '../../../../src/shared/constants';

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getServiceApiKey: vi.fn(() => undefined),
  }),
}));

import { clearFetchCache, fetchDocument } from '../../../../src/host/tools/web/fetchDocument';

function makeResponse(options: {
  ok: boolean;
  status: number;
  statusText?: string;
  body: unknown;
  url?: string;
  contentType?: string;
}): Response {
  return {
    ok: options.ok,
    status: options.status,
    statusText: options.statusText ?? '',
    url: options.url ?? '',
    headers: {
      get: (key: string) => key.toLowerCase() === 'content-type' ? options.contentType ?? '' : null,
    },
    text: async () => typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  } as Response;
}

describe('fetchDocument Firecrawl primary provider', () => {
  beforeEach(() => {
    clearFetchCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearFetchCache();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses Firecrawl scrape before native fetch for public URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({
      ok: true,
      status: 200,
      body: {
        success: true,
        data: {
          markdown: '# Example Domain',
          metadata: {
            scrapeId: 'scrape_123',
            url: 'https://example.com/',
            sourceURL: 'https://example.com',
            statusCode: 200,
            contentType: 'text/html',
            cacheState: 'miss',
          },
        },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const doc = await fetchDocument('https://example.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(SEARCH_API_ENDPOINTS.firecrawlScrape, expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)).toMatchObject({
      url: 'https://example.com',
      formats: ['markdown'],
      onlyMainContent: true,
    });
    expect(doc).toMatchObject({
      content: '# Example Domain',
      contentType: 'text/markdown',
      finalUrl: 'https://example.com/',
      statusCode: 200,
      fromCache: false,
      provider: 'firecrawl',
      providerMode: 'keyless',
      scrapeId: 'scrape_123',
    });
  });

  it('falls back to native fetch when Firecrawl is rate limited', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        body: '{"success":false,"error":"rate limit"}',
      }))
      .mockResolvedValueOnce(makeResponse({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: '<main>Native content</main>',
        url: 'https://example.com',
        contentType: 'text/html; charset=utf-8',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const doc = await fetchDocument('https://example.com');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(SEARCH_API_ENDPOINTS.firecrawlScrape);
    expect(fetchMock.mock.calls[1][0]).toBe('https://example.com');
    expect(doc).toMatchObject({
      content: '<main>Native content</main>',
      contentType: 'text/html; charset=utf-8',
      finalUrl: 'https://example.com',
      provider: 'native',
    });
    expect(doc.fallbackReason).toContain('HTTP 429');
  });

  it('skips Firecrawl for local URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: 'local',
      url: 'http://127.0.0.1:3000',
      contentType: 'text/plain',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const doc = await fetchDocument('http://127.0.0.1:3000');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3000');
    expect(doc.provider).toBe('native');
  });

  it('skips Firecrawl for obvious raw data URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: '{"ok":true}',
      url: 'https://api.example.com/data.json',
      contentType: 'application/json',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const doc = await fetchDocument('https://api.example.com/data.json');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/data.json');
    expect(doc.provider).toBe('native');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_API_ENDPOINTS } from '../../../../src/shared/constants';
import { getAvailableSources, routeSources, SEARCH_SOURCES } from '../../../../src/main/tools/web/search';

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  } as Response;
}

describe('Firecrawl web data source', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is the default available search source without a configured key', () => {
    const configService = {
      getServiceApiKey: vi.fn(() => undefined),
    };

    const sources = getAvailableSources(configService as never);

    expect(sources[0]?.name).toBe('firecrawl');
    expect(routeSources('agent web search', { mode: 'quick' }).sources[0]).toBe('firecrawl');
  });

  it('calls Firecrawl search in keyless mode and maps web results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({
      success: true,
      id: 'search_123',
      creditsUsed: 2,
      data: {
        web: [{
          title: 'Agent Neo',
          url: 'https://agentneo.vercel.app',
          description: 'Agent Neo homepage',
          publishedDate: '2026-06-18',
        }],
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const source = SEARCH_SOURCES.find((entry) => entry.name === 'firecrawl')!;

    const result = await source.search(
      'Agent Neo',
      3,
      { getServiceApiKey: vi.fn(() => undefined) } as never,
      { allowed: ['agentneo.vercel.app'] },
      'week',
    );

    expect(fetchMock).toHaveBeenCalledWith(SEARCH_API_ENDPOINTS.firecrawlSearch, expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({
      query: 'Agent Neo',
      limit: 3,
      includeDomains: ['agentneo.vercel.app'],
      tbs: 'qdr:w',
      sources: [{ type: 'web' }],
    });
    expect(result).toMatchObject({
      source: 'firecrawl-keyless',
      success: true,
      results: [{
        title: 'Agent Neo',
        url: 'https://agentneo.vercel.app',
        snippet: 'Agent Neo homepage',
        source: 'firecrawl-keyless',
      }],
    });
  });

  it('uses the configured Firecrawl key when present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({
      success: true,
      data: { web: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const source = SEARCH_SOURCES.find((entry) => entry.name === 'firecrawl')!;

    await source.search(
      'authenticated search',
      1,
      { getServiceApiKey: vi.fn((service: string) => service === 'firecrawl' ? 'fc-test' : undefined) } as never,
    );

    expect(fetchMock).toHaveBeenCalledWith(SEARCH_API_ENDPOINTS.firecrawlSearch, expect.objectContaining({
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer fc-test',
      },
    }));
  });
});

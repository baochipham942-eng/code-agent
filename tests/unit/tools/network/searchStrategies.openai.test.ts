import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAvailableSources, SEARCH_SOURCES, resetProviderHealthForTests } from '../../../../src/host/tools/web/search';
import { OPENAI_WEB_SEARCH_DEFAULT_MODEL } from '../../../../src/shared/constants';

describe('OpenAI web search source', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEYS', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });

  afterEach(() => {
    resetProviderHealthForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is available when an OpenAI service key is configured', () => {
    const configService = {
      getServiceApiKey: vi.fn((service: string) => service === 'openai' ? 'sk-openai' : undefined),
      getServiceApiBaseUrl: vi.fn(() => undefined),
    };

    const sources = getAvailableSources(configService as never);

    expect(sources.map((source) => source.name)).toContain('openai');
  });

  it('calls OpenAI Responses API with web_search and maps citations', async () => {
    vi.stubEnv('OPENAI_SEARCH_MODEL', 'gpt-search-test');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: 'OpenAI searched the web and found the answer.',
        output: [{
          action: {
            sources: [{
              title: 'OpenAI Web Search Docs Source',
              url: 'https://platform.openai.com/docs/guides/tools-web-search',
            }],
          },
          content: [{
            text: 'OpenAI searched the web and found the answer.',
            annotations: [{
              type: 'url_citation',
              title: 'OpenAI Web Search Docs',
              url: 'https://platform.openai.com/docs/guides/tools-web-search',
            }],
          }],
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const configService = {
      getServiceApiKey: vi.fn((service: string) => service === 'openai' ? 'sk-openai' : undefined),
      getServiceApiBaseUrl: vi.fn(() => undefined),
    };
    const source = SEARCH_SOURCES.find((entry) => entry.name === 'openai');

    const result = await source!.search(
      'OpenAI web search docs',
      5,
      configService as never,
      { allowed: ['platform.openai.com'] },
      'week',
    );

    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-openai' }),
    }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({
      model: 'gpt-search-test',
      tools: [{
        type: 'web_search',
        search_context_size: 'low',
        filters: { allowed_domains: ['platform.openai.com'] },
      }],
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
    });
    expect(body.input).toContain('past 7 days');
    expect(result).toMatchObject({
      source: 'openai',
      success: true,
      answer: 'OpenAI searched the web and found the answer.',
      citations: ['https://platform.openai.com/docs/guides/tools-web-search'],
      results: [{
        title: 'OpenAI Web Search Docs Source',
        url: 'https://platform.openai.com/docs/guides/tools-web-search',
        source: 'openai',
      }],
    });
  });

  it('uses the shared default web search model when env override is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: 'OpenAI searched the web.',
        output: [],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const configService = {
      getServiceApiKey: vi.fn((service: string) => service === 'openai' ? 'sk-openai' : undefined),
      getServiceApiBaseUrl: vi.fn(() => undefined),
    };
    const source = SEARCH_SOURCES.find((entry) => entry.name === 'openai');

    const result = await source!.search('OpenAI web search docs', 5, configService as never);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.model).toBe(OPENAI_WEB_SEARCH_DEFAULT_MODEL);
    expect(result.success).toBe(true);
  });

  it('returns a clear error without calling OpenAI when the service key is missing', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEYS', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const configService = {
      getServiceApiKey: vi.fn(() => undefined),
      getServiceApiBaseUrl: vi.fn(() => undefined),
    };
    const source = SEARCH_SOURCES.find((entry) => entry.name === 'openai');

    const result = await source!.search('OpenAI web search docs', 5, configService as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      source: 'openai',
      success: false,
      error: 'API key not configured',
    });
  });

  it('uses a managed OpenAI-compatible base URL when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: 'Relay searched the web.',
        output: [{
          content: [{
            text: 'Relay searched the web.',
            annotations: [{
              type: 'url_citation',
              title: 'OpenAI Web Search Docs',
              url: 'https://platform.openai.com/docs/guides/tools-web-search',
            }],
          }],
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const configService = {
      getServiceApiKey: vi.fn((service: string) => service === 'openai' ? 'sk-relay-openai' : undefined),
      getServiceApiBaseUrl: vi.fn((service: string) => service === 'openai' ? 'https://free.example/v1/' : undefined),
    };
    const source = SEARCH_SOURCES.find((entry) => entry.name === 'openai');

    const result = await source!.search('OpenAI web search docs', 5, configService as never);

    expect(fetchMock).toHaveBeenCalledWith('https://free.example/v1/responses', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer sk-relay-openai' }),
    }));
    expect(result.success).toBe(true);
  });
});

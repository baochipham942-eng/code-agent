import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetProviderHealthForTests, SEARCH_SOURCES } from '../../../../src/main/tools/web/search';

const source = (name: string) => SEARCH_SOURCES.find((entry) => entry.name === name)!;
const noConfig = {
  getServiceApiKey: () => undefined,
  getServiceApiBaseUrl: () => undefined,
} as never;

describe('premium search provider key pools', () => {
  beforeEach(() => {
    for (const key of [
      'PERPLEXITY_API_KEYS',
      'PERPLEXITY_API_KEY',
      'OPENAI_API_KEYS',
      'OPENAI_API_KEY',
      'EXA_API_KEYS',
      'EXA_API_KEY',
      'TAVILY_API_KEYS',
      'TAVILY_API_KEY',
    ]) {
      vi.stubEnv(key, '');
    }
  });

  afterEach(() => {
    resetProviderHealthForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('rotates Perplexity keys on quota/auth failures', async () => {
    vi.stubEnv('PERPLEXITY_API_KEYS', 'perp-dead,perp-good');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'exceeded quota' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'perplexity answer' } }],
          citations: ['https://example.com/perplexity'],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await source('perplexity').search('query', 5, noConfig);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer perp-dead');
    expect((fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer perp-good');
    expect(result).toMatchObject({
      source: 'perplexity',
      success: true,
      answer: 'perplexity answer',
      citations: ['https://example.com/perplexity'],
    });
  });

  it('rotates EXA keys on billing/quota failures', async () => {
    vi.stubEnv('EXA_API_KEYS', 'exa-dead,exa-good');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 402, text: async () => 'insufficient credits' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{
            title: 'EXA result',
            url: 'https://example.com/exa',
            text: 'result text',
          }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await source('exa').search('query', 5, noConfig);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers['x-api-key'])
      .toBe('exa-dead');
    expect((fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers['x-api-key'])
      .toBe('exa-good');
    expect(result).toMatchObject({
      source: 'exa',
      success: true,
      results: [expect.objectContaining({ url: 'https://example.com/exa' })],
    });
  });

  it('does not burn the whole OpenAI pool on ordinary transient failures', async () => {
    vi.stubEnv('OPENAI_API_KEYS', 'openai-transient,openai-spare');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upstream exploded' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await source('openai').search('query', 5, noConfig);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer openai-transient');
    expect(result).toEqual({
      source: 'openai',
      success: false,
      error: 'HTTP 500: upstream exploded',
    });
  });
});

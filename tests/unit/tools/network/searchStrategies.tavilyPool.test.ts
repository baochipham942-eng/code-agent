import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTavilyKeys, getAvailableSources, SEARCH_SOURCES, resetProviderHealthForTests } from '../../../../src/main/tools/web/search';

const tavilySource = () => SEARCH_SOURCES.find((s) => s.name === 'tavily')!;
const noConfig = { getServiceApiKey: () => undefined } as never;

describe('Tavily key pool', () => {
  beforeEach(() => {
    vi.stubEnv('TAVILY_API_KEYS', '');
    vi.stubEnv('TAVILY_API_KEY', '');
  });

  afterEach(() => {
    resetProviderHealthForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('parses TAVILY_API_KEYS into a deduped ordered pool plus the legacy single key', () => {
    vi.stubEnv('TAVILY_API_KEYS', 'k1, k2\nk3  k2'); // comma / newline / space separated, k2 duplicated
    vi.stubEnv('TAVILY_API_KEY', 'k4'); // legacy single key appended (config has none here)

    expect(getTavilyKeys(noConfig)).toEqual(['k1', 'k2', 'k3', 'k4']);
  });

  it('marks tavily available when only the pool env is set', () => {
    vi.stubEnv('TAVILY_API_KEYS', 'pool-a,pool-b');
    expect(getAvailableSources(noConfig).map((s) => s.name)).toContain('tavily');
  });

  it('rotates to the next key when the current key returns a quota/plan error', async () => {
    // Unique keys so module-level cooldown state does not leak across tests.
    vi.stubEnv('TAVILY_API_KEYS', 'rot-exhausted-1,rot-good-2');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 432, text: async () => 'plan usage limit exceeded' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ answer: 'ok', results: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await tavilySource().search('hello', 5, noConfig);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer rot-exhausted-1');
    expect((fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer rot-good-2');
    expect(result).toMatchObject({ source: 'tavily', success: true, answer: 'ok' });
  });

  it('does not burn the whole pool on a transient (non-quota) error', async () => {
    vi.stubEnv('TAVILY_API_KEYS', 'transient-a,transient-b');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upstream exploded' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await tavilySource().search('hello', 5, noConfig);

    expect(fetchMock).toHaveBeenCalledTimes(1); // stops at first key, no rotation
    expect(result.success).toBe(false);
  });

  it('surfaces a quota error (tripping the outer breaker) when every key is exhausted', async () => {
    vi.stubEnv('TAVILY_API_KEYS', 'dead-1,dead-2');
    const fetchMock = vi.fn()
      .mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    vi.stubGlobal('fetch', fetchMock);

    const result = await tavilySource().search('hello', 5, noConfig);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
  });
});

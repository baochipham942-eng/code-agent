import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAvailableProviderKeys,
  getAvailableSources,
  getProviderCapabilityMatrix,
  getProviderHealth,
  getProviderKeys,
  markProviderKeyCooldown,
  resetProviderHealthForTests,
} from '../../../../src/host/tools/web/search';

const noConfig = { getServiceApiKey: () => undefined } as never;

describe('provider capability matrix and health', () => {
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
    vi.unstubAllEnvs();
  });

  it('parses premium provider key pools from pool env, config key, and legacy env', () => {
    vi.stubEnv('OPENAI_API_KEYS', 'pool-a, pool-b\npool-a');
    vi.stubEnv('OPENAI_API_KEY', 'legacy-c');
    const config = {
      getServiceApiKey: vi.fn((service: string) => service === 'openai' ? 'config-d' : undefined),
    } as never;

    expect(getProviderKeys('openai', config)).toEqual(['pool-a', 'pool-b', 'config-d', 'legacy-c']);
  });

  it('tracks quota/auth failures as long key cooldown and rate limits as short cooldown', () => {
    vi.stubEnv('PERPLEXITY_API_KEYS', 'quota-key,rate-key,healthy-key');
    markProviderKeyCooldown('perplexity', 'quota-key', 'HTTP 401: exceeded quota');
    markProviderKeyCooldown('perplexity', 'rate-key', 'HTTP 429: Too Many Requests');

    const health = getProviderHealth('perplexity', noConfig);

    expect(health).toMatchObject({
      provider: 'perplexity',
      configured: true,
      available: true,
      totalKeys: 3,
      availableKeys: 1,
      coolingDownKeys: 2,
    });
    expect(health.cooldownRemainingMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(getAvailableProviderKeys('perplexity', noConfig)).toEqual(['healthy-key']);
  });

  it('marks a premium source unavailable when every configured key is cooling down', () => {
    vi.stubEnv('EXA_API_KEYS', 'exa-a,exa-b');
    markProviderKeyCooldown('exa', 'exa-a', 'HTTP 402: insufficient credits');
    markProviderKeyCooldown('exa', 'exa-b', 'HTTP 402: insufficient credits');

    expect(getProviderHealth('exa', noConfig)).toMatchObject({
      configured: true,
      available: false,
      totalKeys: 2,
      availableKeys: 0,
      coolingDownKeys: 2,
    });
    expect(getAvailableSources(noConfig, ['exa']).map(source => source.name)).not.toContain('exa');
  });

  it('exposes recency and key-pool capabilities with live health', () => {
    vi.stubEnv('OPENAI_API_KEYS', 'openai-key');
    const matrix = getProviderCapabilityMatrix(noConfig);

    expect(matrix.find(entry => entry.id === 'openai')).toMatchObject({
      recency: 'best_effort',
      domainFilter: 'native',
      citations: 'native',
      keyPool: true,
      health: {
        configured: true,
        available: true,
        totalKeys: 1,
        availableKeys: 1,
      },
    });
    expect(matrix.find(entry => entry.id === 'perplexity')).toMatchObject({
      recency: 'none',
      keyPool: true,
      health: {
        configured: false,
        available: false,
      },
    });
  });
});

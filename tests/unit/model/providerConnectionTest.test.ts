import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleTestConnection,
  resolveConnectionTestModel,
} from '../../../src/host/model/providerConnectionTest';

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getApiKey: vi.fn(() => ''),
  }),
}));

describe('providerConnectionTest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the current Claude provider default when no model is supplied', () => {
    expect(resolveConnectionTestModel('claude')).toBe('claude-opus-4-7');
  });

  it('uses the supplied Claude model for connection tests', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response('', { status: 200 });
    }));

    const result = await handleTestConnection({
      provider: 'claude',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-6',
    });

    expect(result.success).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      model: 'claude-sonnet-4-6',
      max_tokens: 1,
    });
  });

  it('does not fall back to the legacy Claude 3 Haiku test model', async () => {
    const requests: Array<{ init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requests.push({ init });
      return new Response('', { status: 200 });
    }));

    const result = await handleTestConnection({
      provider: 'claude',
      apiKey: 'sk-ant-test',
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      model: 'claude-opus-4-7',
    });
    expect(String(requests[0]?.init.body)).not.toContain('claude-3-haiku-20240307');
  });
});

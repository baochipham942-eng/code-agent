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

  it('keeps the user-supplied model verbatim instead of applying MODEL_MIGRATIONS', () => {
    // 撞名 M-4：中转上游确实提供 deepseek-coder，测试必须打用户填的这个 id
    expect(resolveConnectionTestModel('custom-tokenrhythm', undefined, 'deepseek-coder')).toBe('deepseek-coder');
    expect(resolveConnectionTestModel('deepseek', undefined, 'deepseek-coder')).toBe('deepseek-coder');
  });

  it('sends the user-supplied model verbatim on a claude-protocol relay connection test', async () => {
    // model 只在 claude 协议分支进请求体（openai 路是 GET /models 不带 model）；
    // 用户填的退役期型号（迁移表键）必须原样出网，不能被改写成新型号
    const requests: Array<{ init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requests.push({ init });
      return new Response('', { status: 200 });
    }));

    const result = await handleTestConnection({
      provider: 'custom-tokenrhythm',
      apiKey: 'sk-test',
      baseUrl: 'https://relay.example/v1',
      protocol: 'claude',
      model: 'claude-sonnet-4-20250514',
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      model: 'claude-sonnet-4-20250514',
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

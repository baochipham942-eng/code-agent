// ============================================================================
// generateImageOpenAICompat — 自定义 OpenAI 兼容生图端点调用（借鉴项① Phase2）
//
// 文生图 only。端点形状对齐 OpenAI /v1/images/generations，返回兼容三态：
// data[0].b64_json / data[0].url。断言请求 URL/body 正确，且两种返回都能取到图。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateImageOpenAICompat } from '../../../../src/main/services/media/imageGenerationService';

interface Captured { url: string; headers?: Record<string, string>; body?: Record<string, unknown>; }

function installFetch(response: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return { ok: true, status: 200, json: async () => response, text: async () => JSON.stringify(response) } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => vi.restoreAllMocks());

describe('generateImageOpenAICompat', () => {
  it('打 ${baseUrl}/images/generations，带 Bearer key 与 model/prompt', async () => {
    const calls = installFetch({ data: [{ b64_json: 'QUJD' }] });
    const res = await generateImageOpenAICompat({
      baseUrl: 'https://api.x.com/v1', apiKey: 'sk-test', modelName: 'sdxl', prompt: '一只猫',
    });
    expect(calls[0].url).toBe('https://api.x.com/v1/images/generations');
    expect(calls[0].headers?.Authorization).toBe('Bearer sk-test');
    expect(calls[0].body).toMatchObject({ model: 'sdxl', prompt: '一只猫', n: 1 });
    // b64 → dataURL，actualModel=modelName
    expect(res.imageData).toBe('data:image/png;base64,QUJD');
    expect(res.actualModel).toBe('sdxl');
  });

  it('返回 data[0].url 时直接透传 url（由调用方下载）', async () => {
    installFetch({ data: [{ url: 'https://oss.example.com/out.png' }] });
    const res = await generateImageOpenAICompat({
      baseUrl: 'https://api.x.com/v1', apiKey: 'sk', modelName: 'm', prompt: 'p',
    });
    expect(res.imageData).toBe('https://oss.example.com/out.png');
  });

  it('返回既无 b64 也无 url 时抛错（防空结果）', async () => {
    installFetch({ data: [{}] });
    await expect(
      generateImageOpenAICompat({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', modelName: 'm', prompt: 'p' }),
    ).rejects.toThrow();
  });

  it('非 2xx 透出端点错误正文', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({}), text: async () => 'invalid api key',
    } as unknown as Response)) as unknown as typeof fetch;
    await expect(
      generateImageOpenAICompat({ baseUrl: 'https://api.x.com/v1', apiKey: 'bad', modelName: 'm', prompt: 'p' }),
    ).rejects.toThrow(/401|invalid api key/);
  });
});

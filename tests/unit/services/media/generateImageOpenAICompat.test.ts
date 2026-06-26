// ============================================================================
// generateImageOpenAICompat — 自定义 OpenAI 兼容生图端点调用（借鉴项① Phase2）
//
// 文生图 only。端点形状对齐 OpenAI /v1/images/generations，返回兼容三态：
// data[0].b64_json / data[0].url。断言请求 URL/body 正确，且两种返回都能取到图。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateImageOpenAICompat, sniffImageMimeFromBase64 } from '../../../../src/host/services/media/imageGenerationService';

// 用 magic bytes 造各格式的 base64 头（只需头部，余下补零）。
const b64Of = (bytes: number[]) => Buffer.from([...bytes, ...new Array(12).fill(0)]).toString('base64');

interface Captured { url: string; headers?: Record<string, string>; body?: Record<string, unknown>; redirect?: RequestRedirect; }

function installFetch(response: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
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

  it('b64 按真实 magic 标注 mime（seedream 返回 JPEG 不再误标 png）', async () => {
    installFetch({ data: [{ b64_json: b64Of([0xff, 0xd8, 0xff, 0xe0]) }] }); // JPEG
    const res = await generateImageOpenAICompat({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', modelName: 'm', prompt: 'p' });
    expect(res.imageData.startsWith('data:image/jpeg;base64,')).toBe(true);
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

  it('SSRF-via-redirect 防护：用 redirect:manual 发起，且 3xx 跳转被拒（审计 HIGH-1）', async () => {
    // 端点（用户自填，可能恶意/被攻陷/DNS rebind）返回 302→169.254.169.254 元数据地址：
    // 守卫只校验了初始 host，若透明跟跳转就绕过守卫打内网。生成 POST 必须 redirect:manual + 拒 3xx。
    const calls: Captured[] = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), redirect: init?.redirect });
      return { ok: false, status: 302, json: async () => ({}), text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(
      generateImageOpenAICompat({ baseUrl: 'https://evil.example.com/v1', apiKey: 'sk', modelName: 'm', prompt: 'p' }),
    ).rejects.toThrow(/跳转|redirect|SSRF/i);
    expect(calls[0].redirect).toBe('manual'); // 不透明跟跳转
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

describe('sniffImageMimeFromBase64', () => {
  it('PNG/JPEG/GIF/WEBP magic 各识别正确，未知回退 png', () => {
    expect(sniffImageMimeFromBase64(b64Of([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(sniffImageMimeFromBase64(b64Of([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMimeFromBase64(b64Of([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
    expect(sniffImageMimeFromBase64(Buffer.from('RIFF\0\0\0\0WEBPxxxx').toString('base64'))).toBe('image/webp');
    expect(sniffImageMimeFromBase64(Buffer.from('hello world').toString('base64'))).toBe('image/png');
  });
});

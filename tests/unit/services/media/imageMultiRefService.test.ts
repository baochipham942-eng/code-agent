// ============================================================================
// imageMultiRefService — 多参考图（2-3 张）请求形状（hermetic-protocol）
//
// 真 service + 真 fetchWithAbort，只 mock globalThis.fetch（形状贴 DashScope 真响应）。
// 断言：3 图按序 + 恰好 1 条 text、模型 qwen-image-2.0-pro、不带 size；
// 单参考图仍走 wanx description_edit（请求体不变）。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getApiKeyMock } = vi.hoisted(() => ({ getApiKeyMock: vi.fn() }));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getApiKey: getApiKeyMock }),
}));
vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { generateImageFromReferences } from '../../../../src/host/services/media/imageMultiRefService';
import { generateImageFromReference } from '../../../../src/host/services/media/imageGenerationService';
import { IMAGE_MULTI_REF } from '../../../../src/shared/constants/visualModels';
import { estimateImageCostCny } from '../../../../src/shared/media/imageCost';

const IMG = ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB', 'data:image/webp;base64,CCCC'];
const RESULT_DATA_URL = 'data:image/png;base64,UkVTVUxU';

interface Captured { url: string; body?: Record<string, any> }

function res(obj: unknown): Response {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) } as unknown as Response;
}

function installFetch(): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.includes('multimodal-generation')) {
      return res({ output: { choices: [{ message: { role: 'assistant', content: [{ image: RESULT_DATA_URL }] } }] } });
    }
    if (url.includes('/tasks/')) {
      return res({ output: { task_status: 'SUCCEEDED', results: [{ url: RESULT_DATA_URL }] } });
    }
    return res({ output: { task_id: 'task-1', task_status: 'PENDING' } });
  }) as unknown as typeof fetch;
  return calls;
}

describe('generateImageFromReferences', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.DASHSCOPE_API_KEY = 'sk-test';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.DASHSCOPE_API_KEY;
    vi.restoreAllMocks();
  });

  it('3 张参考图：body 为 3 个 image（按序）+ 恰好 1 个 text，模型 qwen-image-2.0-pro，不带 size', async () => {
    const calls = installFetch();
    const out = await generateImageFromReferences({ prompt: '图2的模特穿图1的裙子', referenceImageDataUrls: IMG });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(IMAGE_MULTI_REF.GENERATION_PATH);
    const body = calls[0].body!;
    expect(body.model).toBe('qwen-image-2.0-pro');
    const content = body.input.messages[0].content as Array<Record<string, string>>;
    expect(content).toEqual([
      { image: IMG[0] },
      { image: IMG[1] },
      { image: IMG[2] },
      { text: '图2的模特穿图1的裙子' },
    ]);
    expect(content.filter((c) => 'text' in c)).toHaveLength(1);
    expect(body.parameters).toEqual({ n: 1 });
    expect(JSON.stringify(body)).not.toContain('"size"');
    expect(out).toEqual({ imageData: RESULT_DATA_URL, actualModel: 'qwen-image-2.0-pro' });
  });

  it('响应不含图片 URL 时报错', async () => {
    globalThis.fetch = vi.fn(async () => res({ output: { choices: [{ message: { content: [] } }] } })) as unknown as typeof fetch;
    await expect(generateImageFromReferences({ prompt: 'p', referenceImageDataUrls: IMG.slice(0, 2) }))
      .rejects.toThrow('未返回图片 URL');
  });

  // r3 review Important：content 为纯字符串（正文带 https 链接）不是文档形状，
  // 不得正则取链接当结果图下载——那会把拒绝说明里的文档链接存成 png 并按张计价。
  it('content 为纯字符串（含 https 链接）时按「未返回图片 URL」拒绝，且只发一次请求', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return res({ output: { choices: [{ message: { content: '请求被内容安全策略拒绝，参见 https://help.example.com/doc-123 说明页。' } }] } });
    }) as unknown as typeof fetch;
    await expect(generateImageFromReferences({ prompt: 'p', referenceImageDataUrls: IMG.slice(0, 2) }))
      .rejects.toThrow('未返回图片 URL');
    expect(calls).toHaveLength(1);
  });

  // r3 review Nit：image 值非 https:// 非 data: 时不得原样当 imageData 落盘（会解码出坏图）。
  it('content[].image 为非 https 非 data: 字符串时按「未返回图片 URL」拒绝', async () => {
    globalThis.fetch = vi.fn(async () => res({ output: { choices: [{ message: { content: [{ image: 'not-a-url.png' }] } }] } })) as unknown as typeof fetch;
    await expect(generateImageFromReferences({ prompt: 'p', referenceImageDataUrls: IMG.slice(0, 2) }))
      .rejects.toThrow('未返回图片 URL');
  });

  // r3 review Nit：百炼错误体超长时截断，防撑大工具输出。
  it('非 2xx 错误体截断到 500 字符', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => 'x'.repeat(2000),
    })) as unknown as typeof fetch;
    const caught = await generateImageFromReferences({ prompt: 'p', referenceImageDataUrls: IMG.slice(0, 2) })
      .then(() => undefined, (e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) throw new Error('expected the call to reject');
    expect(caught.message).toContain('429');
    expect(caught.message.length).toBeLessThan(600);
  });

  it('1 张参考图仍走万相 description_edit（请求体不变），不碰多图端点', async () => {
    const calls = installFetch();
    const out = await generateImageFromReference({ prompt: 'p', referenceImageDataUrl: IMG[0] });
    expect(calls.some((c) => c.url.includes('multimodal-generation'))).toBe(false);
    expect(calls[0].body).toEqual({
      model: 'wanx2.1-imageedit',
      input: { function: 'description_edit', prompt: 'p', base_image_url: IMG[0] },
      parameters: { n: 1 },
    });
    expect(out.actualModel).toBe('wanx2.1-imageedit');
  });

  it('价表：qwen 多图 0.5 元，高于万相单图', () => {
    expect(estimateImageCostCny('qwen-image-2.0-pro')).toBe(0.5);
    expect(estimateImageCostCny('wanx2.1-imageedit')).toBeLessThan(0.5);
  });
});

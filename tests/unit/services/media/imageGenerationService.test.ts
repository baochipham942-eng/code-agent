// ============================================================================
// imageGenerationService — wanx 扩图(expand) / 去水印(remove_watermark) wrapper 测试
//
// T3：复用 submitAndPollWanx，新增两个 function wrapper + 扩图方向→四向 scale 映射。
// 断言提交给 DashScope 的 body 形状（model/function/参数）严格符合 wanx2.1-imageedit API，
// 避免 dogfood 真调时因参数错误报错。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  expandImage,
  removeWatermark,
  expandScalesForDirection,
} from '../../../../src/main/services/media/imageGenerationService';

function jsonResponse(obj: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  } as unknown as Response;
}

interface CapturedCall {
  url: string;
  body?: Record<string, unknown>;
}

/** 模拟 DashScope 异步：第一次（提交）返回 task_id，后续 /tasks/ 轮询返回 SUCCEEDED + 结果 url。 */
function installFetchMock(resultUrl = 'https://oss.example.com/out.png'): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.includes('/tasks/')) {
      return jsonResponse({ output: { task_status: 'SUCCEEDED', results: [{ url: resultUrl }] } });
    }
    return jsonResponse({ output: { task_id: 'task-abc', task_status: 'PENDING' } });
  }) as unknown as typeof fetch;
  return calls;
}

const DATA_URL = 'data:image/png;base64,AAAA';

describe('expandScalesForDirection — 扩图方向→四向 scale 映射', () => {
  it('单向扩展只抬对应边，其余保持 1.0', () => {
    expect(expandScalesForDirection('up', 1.5)).toEqual({ top: 1.5, bottom: 1, left: 1, right: 1 });
    expect(expandScalesForDirection('down', 1.5)).toEqual({ top: 1, bottom: 1.5, left: 1, right: 1 });
    expect(expandScalesForDirection('left', 1.5)).toEqual({ top: 1, bottom: 1, left: 1.5, right: 1 });
    expect(expandScalesForDirection('right', 1.5)).toEqual({ top: 1, bottom: 1, left: 1, right: 1.5 });
  });

  it('四周(all) 四向同时按比例扩展', () => {
    expect(expandScalesForDirection('all', 1.5)).toEqual({ top: 1.5, bottom: 1.5, left: 1.5, right: 1.5 });
  });

  it('比例 clamp 到 [1.0, 2.0]', () => {
    expect(expandScalesForDirection('all', 3.0)).toEqual({ top: 2, bottom: 2, left: 2, right: 2 });
    expect(expandScalesForDirection('all', 0.5)).toEqual({ top: 1, bottom: 1, left: 1, right: 1 });
    expect(expandScalesForDirection('up', Number.NaN)).toEqual({ top: 1, bottom: 1, left: 1, right: 1 });
  });
});

describe('expandImage — wanx function=expand', () => {
  beforeEach(() => installFetchMock());
  afterEach(() => vi.restoreAllMocks());

  it('提交 body 严格符合 wanx2.1-imageedit expand schema', async () => {
    const calls = installFetchMock();
    const result = await expandImage({
      apiKey: 'sk-test',
      prompt: '自然延伸背景',
      baseImageDataUrl: DATA_URL,
      topScale: 1.5,
      bottomScale: 1,
      leftScale: 1,
      rightScale: 1.2,
    });
    expect(result).toEqual({ url: 'https://oss.example.com/out.png' });

    const submit = calls[0];
    expect(submit.url).toContain('/services/aigc/image2image/image-synthesis');
    expect(submit.body).toMatchObject({
      model: 'wanx2.1-imageedit',
      input: {
        function: 'expand',
        prompt: '自然延伸背景',
        base_image_url: DATA_URL,
      },
      parameters: {
        top_scale: 1.5,
        bottom_scale: 1,
        left_scale: 1,
        right_scale: 1.2,
        n: 1,
      },
    });
  });

  it('scale 缺省时默认 1.0 且 clamp 越界值', async () => {
    const calls = installFetchMock();
    await expandImage({ apiKey: 'sk', prompt: 'p', baseImageDataUrl: DATA_URL, topScale: 99 });
    expect(calls[0].body?.parameters).toMatchObject({
      top_scale: 2,
      bottom_scale: 1,
      left_scale: 1,
      right_scale: 1,
    });
  });
});

describe('removeWatermark — wanx function=remove_watermark', () => {
  afterEach(() => vi.restoreAllMocks());

  it('提交 body 含 function=remove_watermark 与默认去水印 prompt', async () => {
    const calls = installFetchMock();
    const result = await removeWatermark({ apiKey: 'sk', baseImageDataUrl: DATA_URL });
    expect(result).toEqual({ url: 'https://oss.example.com/out.png' });

    expect(calls[0].body).toMatchObject({
      model: 'wanx2.1-imageedit',
      input: { function: 'remove_watermark', base_image_url: DATA_URL },
      parameters: { n: 1 },
    });
    // wanx 要求 prompt 非空（即使语义不用）
    const input = calls[0].body?.input as Record<string, unknown>;
    expect(typeof input.prompt).toBe('string');
    expect((input.prompt as string).length).toBeGreaterThan(0);
  });

  it('显式传 prompt 时透传', async () => {
    const calls = installFetchMock();
    await removeWatermark({ apiKey: 'sk', baseImageDataUrl: DATA_URL, prompt: '去除右下角logo' });
    const input = calls[0].body?.input as Record<string, unknown>;
    expect(input.prompt).toBe('去除右下角logo');
  });
});

describe('gptimage engine — gpt-image-2 自定义 OpenAI 兼容端点', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GPTIMAGE_PROXY_BASE;
    delete process.env.GPTIMAGE_PROXY_KEY;
  });

  it('gptimage engine 调 /v1/images/generations 取 b64，不加 NO_TEXT', async () => {
    process.env.GPTIMAGE_PROXY_BASE = 'https://example.test';
    process.env.GPTIMAGE_PROXY_KEY = 'sk-test';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ b64_json: 'AAA' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const { generateImage } = await import('../../../../src/main/services/media/imageGenerationService');
    const r = await generateImage('gptimage', '', '深色仪表盘', '1:1');
    expect(r.actualModel).toBe('gpt-image-2');
    expect(r.imageData.startsWith('data:image/png;base64,')).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-image-2');
    expect(body.prompt).not.toMatch(/不要出现任何文字/); // 设计场景保留文字
  });

  it('gptimage 缺 key 报去设置配置', async () => {
    delete process.env.GPTIMAGE_PROXY_BASE;
    delete process.env.GPTIMAGE_PROXY_KEY;
    // 且 config 无 gptimage key → 抛含「配置」字样错误
    const { generateImage } = await import('../../../../src/main/services/media/imageGenerationService');
    await expect(generateImage('gptimage', '', 'x', '1:1')).rejects.toThrow(/配置/);
  });
});

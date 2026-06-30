// ============================================================================
// imageGenerationService — wanx 扩图(expand) / 去水印(remove_watermark) wrapper 测试
//
// T3：复用 submitAndPollWanx，新增两个 function wrapper + 扩图方向→四向 scale 映射。
// 断言提交给 DashScope 的 body 形状（model/function/参数）严格符合 wanx2.1-imageedit API，
// 避免 dogfood 真调时因参数错误报错。
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 显式 mock configService，让 getGptImageConfig 的 config 回落路径可控（不依赖测试环境恰好返回 undefined）。
const { getApiKeyMock } = vi.hoisted(() => ({ getApiKeyMock: vi.fn() }));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getApiKey: getApiKeyMock }),
}));

import {
  expandImage,
  removeWatermark,
  expandScalesForDirection,
  isSafeImageUrl,
  getArkApiKey,
} from '../../../../src/host/services/media/imageGenerationService';

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
    expect(result).toEqual({ url: 'https://oss.example.com/out.png', actualModel: 'wanx2.1-imageedit' });

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
    expect(result).toEqual({ url: 'https://oss.example.com/out.png', actualModel: 'wanx2.1-imageedit' });

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
  beforeEach(() => {
    // 默认 config 无任何 key（缺-key 路径），各用例按需覆盖。
    getApiKeyMock.mockReset();
    getApiKeyMock.mockReturnValue(undefined);
    delete process.env.GPTIMAGE_PROXY_BASE;
    delete process.env.GPTIMAGE_PROXY_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    getApiKeyMock.mockReset();
    delete process.env.GPTIMAGE_PROXY_BASE;
    delete process.env.GPTIMAGE_PROXY_KEY;
  });

  it('gptimage engine 调 /v1/images/generations 取 b64，不加 NO_TEXT', async () => {
    process.env.GPTIMAGE_PROXY_BASE = 'https://example.test';
    process.env.GPTIMAGE_PROXY_KEY = 'sk-test';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ b64_json: 'AAA' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const { generateImage } = await import('../../../../src/host/services/media/imageGenerationService');
    const r = await generateImage('gptimage', '', '深色仪表盘', '1:1');
    expect(r.actualModel).toBe('gpt-image-2');
    expect(r.imageData.startsWith('data:image/png;base64,')).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-image-2');
    expect(body.prompt).not.toMatch(/不要出现任何文字/); // 设计场景保留文字
  });

  it('env 缺失时回落 config slot（gptimage-base/gptimage）也能出图', async () => {
    // 不设 env，改由 config slot 提供 base+key，覆盖 getGptImageConfig 的 config 回落分支。
    getApiKeyMock.mockImplementation((slot: string) => {
      if (slot === 'gptimage-base') return 'https://config.test/';
      if (slot === 'gptimage') return 'sk-config';
      return undefined;
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ b64_json: 'BBB' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    const { generateImage } = await import('../../../../src/host/services/media/imageGenerationService');
    const r = await generateImage('gptimage', '', '深色仪表盘', '1:1');
    expect(r.actualModel).toBe('gpt-image-2');
    expect(r.imageData).toBe('data:image/png;base64,BBB');
    // base 尾部斜杠应被归一化，路径拼接无双斜杠。
    expect(fetchMock.mock.calls[0][0]).toBe('https://config.test/v1/images/generations');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-config');
  });

  it('非 ok 响应把第三方中转错误正文拼进异常', async () => {
    process.env.GPTIMAGE_PROXY_BASE = 'https://example.test';
    process.env.GPTIMAGE_PROXY_KEY = 'sk-test';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"error":"quota exceeded"}',
    });
    vi.stubGlobal('fetch', fetchMock);
    const { generateImage } = await import('../../../../src/host/services/media/imageGenerationService');
    await expect(generateImage('gptimage', '', 'x', '1:1')).rejects.toThrow(/429.*quota exceeded/);
  });

  it('gptimage 缺 key 报去设置配置', async () => {
    // env 已在 beforeEach 删除，且 config 显式返回 undefined（mockReturnValue(undefined)）
    // → 走的是真·缺 key 路径，断言抛含「配置」字样错误。
    const { generateImage } = await import('../../../../src/host/services/media/imageGenerationService');
    await expect(generateImage('gptimage', '', 'x', '1:1')).rejects.toThrow(/配置/);
  });
});

describe('editImageByAnnotation — gptimage /v1/images/edits multipart 标注重绘', () => {
  beforeEach(() => {
    getApiKeyMock.mockReset();
    getApiKeyMock.mockReturnValue(undefined);
    delete process.env.GPTIMAGE_PROXY_BASE;
    delete process.env.GPTIMAGE_PROXY_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    getApiKeyMock.mockReset();
    delete process.env.GPTIMAGE_PROXY_BASE;
    delete process.env.GPTIMAGE_PROXY_KEY;
  });

  it('editImageByAnnotation(gptimage) 走 /v1/images/edits multipart 取 b64', async () => {
    process.env.GPTIMAGE_PROXY_BASE = 'https://example.test';
    process.env.GPTIMAGE_PROXY_KEY = 'sk-test';
    let capturedUrl = ''; let capturedBody: any = null;
    const fetchMock = vi.fn().mockImplementation(async (url: string, init: any) => {
      capturedUrl = url; capturedBody = init.body;
      return { ok: true, json: async () => ({ data: [{ b64_json: 'QUJD' }] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { editImageByAnnotation } = await import('../../../../src/host/services/media/imageGenerationService');
    const r = await editImageByAnnotation({
      engine: 'gptimage',
      annotatedImageDataUrl: 'data:image/png;base64,QUJD',
      instruction: '把红圈处 logo 改成猫头',
    });
    expect(r.actualModel).toBe('gpt-image-2');
    expect(r.imageData.startsWith('data:image/png;base64,')).toBe(true);
    expect(capturedUrl).toBe('https://example.test/v1/images/edits');
    expect(capturedBody).toBeInstanceOf(FormData);
    expect(capturedBody.get('model')).toBe('gpt-image-2');
    expect(capturedBody.get('prompt')).toBe('把红圈处 logo 改成猫头');
    expect(capturedBody.get('image')).toBeInstanceOf(Blob);
  });

  it('editImageByAnnotation 缺 key 报配置', async () => {
    delete process.env.GPTIMAGE_PROXY_BASE; delete process.env.GPTIMAGE_PROXY_KEY;
    getApiKeyMock.mockReturnValue(undefined);
    const { editImageByAnnotation } = await import('../../../../src/host/services/media/imageGenerationService');
    await expect(editImageByAnnotation({ engine: 'gptimage', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: 'x' }))
      .rejects.toThrow(/配置/);
  });

  it('editImageByAnnotation 非 ok 透出错误体', async () => {
    process.env.GPTIMAGE_PROXY_BASE = 'https://example.test'; process.env.GPTIMAGE_PROXY_KEY = 'sk-test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'quota exceeded' }));
    const { editImageByAnnotation } = await import('../../../../src/host/services/media/imageGenerationService');
    await expect(editImageByAnnotation({ engine: 'gptimage', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: 'x' }))
      .rejects.toThrow(/429.*quota exceeded/);
  });

  it('editImageByAnnotation 非 gptimage engine 抛不支持', async () => {
    const { editImageByAnnotation } = await import('../../../../src/host/services/media/imageGenerationService');
    await expect(editImageByAnnotation({ engine: 'wanx', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: 'x' }))
      .rejects.toThrow(/不支持|标注重绘/);
  });
  it('editImageByAnnotation 空 base64 抛错且不发起 fetch（防 paid no-op）', async () => {
    process.env.GPTIMAGE_PROXY_BASE = 'https://example.test';
    process.env.GPTIMAGE_PROXY_KEY = 'sk-test';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { editImageByAnnotation } = await import('../../../../src/host/services/media/imageGenerationService');
    await expect(editImageByAnnotation({ engine: 'gptimage', annotatedImageDataUrl: 'data:image/png;base64,', instruction: 'x' }))
      .rejects.toThrow(/base64 为空/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('isSafeImageUrl SSRF 守卫 (D9)', () => {
  it('仅允许 https 公网，拒 http/私网/元数据地址', () => {
    expect(isSafeImageUrl('https://dashscope-result.oss-cn.aliyuncs.com/x.png')).toBe(true);
    expect(isSafeImageUrl('http://example.com/x.png')).toBe(false);       // 非 https
    expect(isSafeImageUrl('https://127.0.0.1/x')).toBe(false);
    expect(isSafeImageUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafeImageUrl('https://192.168.1.10/x')).toBe(false);
    expect(isSafeImageUrl('https://10.0.0.5/x')).toBe(false);
    expect(isSafeImageUrl('https://172.16.0.1/x')).toBe(false);
    expect(isSafeImageUrl('https://localhost/x')).toBe(false);
    expect(isSafeImageUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeImageUrl('not a url')).toBe(false);
  });

  it('IPv6 字面量私网/环回/链路本地/mapped 全拒，公网域名不误杀', () => {
    expect(isSafeImageUrl('https://[::1]/x')).toBe(false);
    expect(isSafeImageUrl('https://[fc00::1]/x')).toBe(false);
    expect(isSafeImageUrl('https://[fe80::1]/x')).toBe(false);
    expect(isSafeImageUrl('https://[::ffff:127.0.0.1]/x')).toBe(false);  // IPv4-mapped 环回
    expect(isSafeImageUrl('https://fcbarcelona.com/x.png')).toBe(true);  // 公网域名不误杀
    expect(isSafeImageUrl('https://fd-assets.net/x.png')).toBe(true);
    expect(isSafeImageUrl('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/x.png')).toBe(true); // wanx 不回归
  });

  it('downloadImageAsBase64 下载前拦截不安全 url（不发起 fetch）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { downloadImageAsBase64 } = await import('../../../../src/host/services/media/imageGenerationService');
    await expect(downloadImageAsBase64('http://127.0.0.1/x')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('downloadImageAsBase64 用 redirect:manual 且拒 3xx 跳转（防 SSRF-via-redirect 绕过私网守卫）', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      // 断言走 manual 模式（不让 undici 透明跟跳转到私网）
      expect(init?.redirect).toBe('manual');
      return { ok: false, status: 302, headers: { get: () => 'https://169.254.169.254/' }, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { downloadImageAsBase64 } = await import('../../../../src/host/services/media/imageGenerationService');
    await expect(downloadImageAsBase64('https://cdn.public.example.com/img.png')).rejects.toThrow(/跳转|redirect|下载失败/);
    vi.unstubAllGlobals();
  });
});

describe('getArkApiKey', () => {
  const orig = process.env.ARK_API_KEY;
  afterEach(() => { if (orig === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = orig; });
  it('env ARK_API_KEY 优先', () => {
    process.env.ARK_API_KEY = 'env-ark-key';
    expect(getArkApiKey()).toBe('env-ark-key');
  });
});

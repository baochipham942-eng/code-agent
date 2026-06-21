import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getApiKeyMock } = vi.hoisted(() => ({ getApiKeyMock: vi.fn() }));
vi.mock('../../../../src/main/services/core/configService', () => ({
  getConfigService: () => ({ getApiKey: getApiKeyMock }),
}));

import { generateVideo, downloadVideoAsBuffer } from '../../../../src/main/services/media/videoGenerationService';

function jsonResponse(obj: unknown): Response {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) } as unknown as Response;
}

interface CapturedCall { url: string; body?: Record<string, unknown>; headers?: Record<string, string>; }

function installFetchMock(videoUrl = 'https://oss.example.com/out.mp4'): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: init?.headers as Record<string, string> });
    if (url.includes('/tasks/')) {
      return jsonResponse({ output: { task_status: 'SUCCEEDED', video_url: videoUrl } });
    }
    return jsonResponse({ output: { task_id: 'task-vid-1', task_status: 'PENDING' } });
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  getApiKeyMock.mockReset();
  getApiKeyMock.mockReturnValue('sk-dashscope-test');
  delete process.env.DASHSCOPE_API_KEY;
});

describe('generateVideo — t2v', () => {
  it('提交到视频端点，body 形如 {model,input:{prompt},parameters:{resolution,duration}}，解析 output.video_url', { timeout: 30000 }, async () => {
    const calls = installFetchMock();
    const res = await generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: '一只猫在跑', durationSec: 8 });
    expect(res.url).toBe('https://oss.example.com/out.mp4');
    expect(res.actualModel).toBe('wan2.7-t2v');
    expect(res.durationSec).toBe(8);
    const submit = calls[0];
    expect(submit.url).toContain('/services/aigc/video-generation/video-synthesis');
    expect(submit.headers?.['X-DashScope-Async']).toBe('enable');
    expect(submit.body).toMatchObject({
      model: 'wan2.7-t2v',
      input: { prompt: '一只猫在跑' },
      parameters: { duration: 8 },
    });
    expect((submit.body?.parameters as Record<string, unknown>).resolution).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/tasks/task-vid-1'))).toBe(true);
  });
});

describe('generateVideo — i2v', () => {
  it('底图走 input.img_url，prompt 可选，时长按固定模型 clamp 到 5s', { timeout: 30000 }, async () => {
    const calls = installFetchMock();
    const res = await generateVideo({
      model: 'wanx2.1-i2v-turbo',
      mode: 'i2v',
      imageDataUrl: 'data:image/png;base64,AAAA',
      durationSec: 12,
    });
    expect(res.durationSec).toBe(5);
    expect(calls[0].body).toMatchObject({
      model: 'wanx2.1-i2v-turbo',
      input: { img_url: 'data:image/png;base64,AAAA' },
    });
  });

  it('i2v 缺底图直接抛错，不发起任何请求（防付费空调用）', async () => {
    const calls = installFetchMock();
    await expect(generateVideo({ model: 'wanx2.1-i2v-turbo', mode: 'i2v' })).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});

describe('generateVideo — 守门与失败', () => {
  it('未知模型抛错，不发起请求', async () => {
    const calls = installFetchMock();
    await expect(generateVideo({ model: 'no-such', mode: 't2v', prompt: 'x' })).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it('缺 key 抛可读错误，不发起请求', async () => {
    getApiKeyMock.mockReturnValue(undefined);
    const calls = installFetchMock();
    await expect(generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: 'x' })).rejects.toThrow(/DashScope|百炼|Key/);
    expect(calls.length).toBe(0);
  });

  it('任务 FAILED 抛错', { timeout: 30000 }, async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/tasks/')) return jsonResponse({ output: { task_status: 'FAILED', message: 'boom' } });
      return jsonResponse({ output: { task_id: 't1', task_status: 'PENDING' } });
    }) as unknown as typeof fetch;
    await expect(generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: 'x' })).rejects.toThrow(/FAILED|boom/);
  });
});

describe('downloadVideoAsBuffer — SSRF 守卫 + 下载', () => {
  it('拒绝非 https / 私网 url，不发起请求', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(downloadVideoAsBuffer('http://127.0.0.1/x.mp4')).rejects.toThrow();
    await expect(downloadVideoAsBuffer('https://10.0.0.1/x.mp4')).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('HTTP !ok 抛错', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response) as unknown as typeof fetch;
    await expect(downloadVideoAsBuffer('https://oss.example.com/x.mp4')).rejects.toThrow(/500|下载失败/);
  });
  it('happy path 返回视频字节 Buffer', async () => {
    const bytes = new TextEncoder().encode('MP4BYTES');
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }) as unknown as Response) as unknown as typeof fetch;
    const buf = await downloadVideoAsBuffer('https://oss.example.com/x.mp4');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('MP4BYTES');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateVideoOpenAICompat, downloadVideoAsBuffer } from '../../../src/host/services/media/videoGenerationService';

describe('generateVideoOpenAICompat', () => {
  beforeEach(() => {
    const responses = [
      { ok: true, json: async () => ({ video_id: 'vid1', status: 'queued' }) },          // create
      { ok: true, json: async () => ({ status: 'completed', remixed_from_video_id: 'https://v/u.mp4' }) }, // poll
    ];
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(responses.shift())));
  });

  it('Agnes flavor：建任务→poll→取 remixed_from_video_id', async () => {
    const r = await generateVideoOpenAICompat({
      baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk', modelName: 'agnes-video-v2.0',
      mode: 't2v', prompt: 'a cat', pollIntervalMs: 1, maxPolls: 3,
    });
    expect(r.url).toBe('https://v/u.mp4');
    expect(r.actualModel).toBe('agnes-video-v2.0');
  });

  it('t2v 空 prompt 抛错（付费前置守卫）', async () => {
    await expect(generateVideoOpenAICompat({
      baseUrl: 'https://x.com/v1', apiKey: 'sk', modelName: 'm', mode: 't2v', prompt: '  ', pollIntervalMs: 1, maxPolls: 1,
    })).rejects.toThrow();
  });

  it('i2v 缺底图抛错', async () => {
    await expect(generateVideoOpenAICompat({
      baseUrl: 'https://x.com/v1', apiKey: 'sk', modelName: 'm', mode: 'i2v', pollIntervalMs: 1, maxPolls: 1,
    })).rejects.toThrow();
  });
});

describe('downloadVideoAsBuffer SSRF-via-redirect 防护（终审 H1）', () => {
  it('下载遇 3xx 重定向时抛错，不返回 buffer（防跳私网/元数据）', async () => {
    // redirect:'manual' 下 fetch 不跟随 3xx，resp.status=302/ok=false → handler 须拒绝。
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ status: 302, ok: false, arrayBuffer: async () => new ArrayBuffer(0) })));
    await expect(downloadVideoAsBuffer('https://cdn.example.com/clip.mp4')).rejects.toThrow(/重定向/);
  });
});

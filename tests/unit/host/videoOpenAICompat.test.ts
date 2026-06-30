import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateVideoOpenAICompat } from '../../../src/host/services/media/videoGenerationService';

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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { veoRequest, isGoogleApiUrl } = vi.hoisted(() => ({ veoRequest: vi.fn(), isGoogleApiUrl: vi.fn(() => true) }));
vi.mock('../../../src/host/services/media/veoFetch', () => ({ veoRequest, isGoogleApiUrl }));
const { getGeminiApiKey } = vi.hoisted(() => ({ getGeminiApiKey: vi.fn((): string | undefined => 'k') }));
vi.mock('../../../src/host/services/media/imageGenerationService', async (orig) => ({
  ...(await orig<typeof import('../../../src/host/services/media/imageGenerationService')>()),
  getGeminiApiKey,
}));

import { extractVeoVideoUri, generateVeoVideo, downloadVeoFile } from '../../../src/host/services/media/videoGenerationService';

describe('extractVeoVideoUri', () => {
  it('命中 generatedSamples[0].video.uri', () => {
    expect(extractVeoVideoUri({ generateVideoResponse: { generatedSamples: [{ video: { uri: 'u1' } }] } })).toBe('u1');
  });
  it('兜底 generatedVideos[0].video.uri', () => {
    expect(extractVeoVideoUri({ generateVideoResponse: { generatedVideos: [{ video: { uri: 'u2' } }] } })).toBe('u2');
  });
  it('无视频返回 undefined', () => {
    expect(extractVeoVideoUri({ generateVideoResponse: {} })).toBeUndefined();
  });
});

describe('generateVeoVideo', () => {
  beforeEach(() => { veoRequest.mockReset(); getGeminiApiKey.mockReturnValue('k'); isGoogleApiUrl.mockReturnValue(true); });

  it('t2v：建任务→done→取 uri→下载返回 Buffer', async () => {
    veoRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: { name: 'models/veo-3.1-fast-generate-preview/operations/x' } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://x.googleapis.com/v.mp4' } }] } } } })
      .mockResolvedValueOnce({ ok: true, status: 200, buffer: Buffer.from([9, 9]) });
    const r = await generateVeoVideo({ model: 'veo-3.1-fast-generate-preview', mode: 't2v', prompt: 'a cat', pollIntervalMsOverride: 1 });
    expect(r.actualModel).toBe('veo-3.1-fast-generate-preview');
    expect(r.durationSec).toBe(8);
    expect(r.buffer.length).toBe(2);
    expect((veoRequest.mock.calls[0][1] as any).body.instances[0].prompt).toBe('a cat');
  });

  it('缺 key：抛错且不发任何请求（付费前置守卫）', async () => {
    getGeminiApiKey.mockReturnValue(undefined);
    await expect(generateVeoVideo({ model: 'veo-3.1-fast-generate-preview', mode: 't2v', prompt: 'x' })).rejects.toThrow(/Gemini/);
    expect(veoRequest).not.toHaveBeenCalled();
  });

  it('t2v 空 prompt：抛错且不发请求', async () => {
    await expect(generateVeoVideo({ model: 'veo-3.1-fast-generate-preview', mode: 't2v', prompt: '  ' })).rejects.toThrow();
    expect(veoRequest).not.toHaveBeenCalled();
  });

  it('i2v 缺底图：抛错', async () => {
    await expect(generateVeoVideo({ model: 'veo-3.1-fast-generate-preview', mode: 'i2v', prompt: 'x' })).rejects.toThrow();
  });

  it('i2v：底图 data URL 解析进 image.bytesBase64Encoded', async () => {
    veoRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: { name: 'op/1' } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://x.googleapis.com/v.mp4' } }] } } } })
      .mockResolvedValueOnce({ ok: true, status: 200, buffer: Buffer.from([1]) });
    await generateVeoVideo({ model: 'veo-3.1-fast-generate-preview', mode: 'i2v', imageDataUrl: 'data:image/png;base64,QUJD', pollIntervalMsOverride: 1 });
    const img = (veoRequest.mock.calls[0][1] as any).body.instances[0].image;
    expect(img).toEqual({ bytesBase64Encoded: 'QUJD', mimeType: 'image/png' });
  });

  it('done 带 error：抛错', async () => {
    veoRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: { name: 'op/1' } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { done: true, error: { message: 'boom' } } });
    await expect(generateVeoVideo({ model: 'veo-3.1-fast-generate-preview', mode: 't2v', prompt: 'x', pollIntervalMsOverride: 1 })).rejects.toThrow(/boom|失败/);
  });

  it('create !ok：抛错带状态码，不进轮询', async () => {
    veoRequest.mockResolvedValueOnce({ ok: false, status: 400, data: {} });
    await expect(generateVeoVideo({ model: 'veo-3.1-fast-generate-preview', mode: 't2v', prompt: 'x', pollIntervalMsOverride: 1 })).rejects.toThrow(/400|建任务失败/);
    expect(veoRequest).toHaveBeenCalledTimes(1); // 只 create，没 poll
  });

  it('poll 403：快速失败不空转', async () => {
    veoRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: { name: 'op/1' } })
      .mockResolvedValueOnce({ ok: false, status: 403, data: {} });
    await expect(generateVeoVideo({ model: 'veo-3.1-fast-generate-preview', mode: 't2v', prompt: 'x', pollIntervalMsOverride: 1 })).rejects.toThrow(/403|轮询失败/);
  });
});

describe('downloadVeoFile SSRF', () => {
  beforeEach(() => { veoRequest.mockReset(); });
  it('非 Google 域：拒绝下载且不发请求', async () => {
    isGoogleApiUrl.mockReturnValue(false);
    await expect(downloadVeoFile('https://evil.com/v.mp4', 'k')).rejects.toThrow(/Google/);
    expect(veoRequest).not.toHaveBeenCalled();
  });
  it('3xx 重定向：拒绝', async () => {
    isGoogleApiUrl.mockReturnValue(true);
    veoRequest.mockResolvedValue({ ok: false, status: 302 });
    await expect(downloadVeoFile('https://x.googleapis.com/v.mp4', 'k')).rejects.toThrow(/重定向/);
  });
});

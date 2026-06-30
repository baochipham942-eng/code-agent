import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateMusic } from '../../../src/host/services/media/musicGenerationService';

describe('generateMusic（MiniMax）', () => {
  it('POST /music_generation，hex 音频解码为 Buffer', async () => {
    const hex = Buffer.from('FAKE-MP3-BYTES').toString('hex');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, json: async () => ({ data: { audio: hex, status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }),
    })));
    const r = await generateMusic({ baseUrl: 'https://api.minimax.io/v1', apiKey: 'sk', modelName: 'music-2.6', prompt: 'pop, upbeat', lyrics: '[verse] hi' });
    expect(r.actualModel).toBe('music-2.6');
    expect(Buffer.isBuffer(r.audioBuffer)).toBe(true);
    expect(r.audioBuffer.toString()).toBe('FAKE-MP3-BYTES');
  });
  it('base_resp.status_code 非 0 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, json: async () => ({ base_resp: { status_code: 1004, status_msg: 'auth failed' } }),
    })));
    await expect(generateMusic({ baseUrl: 'https://api.minimax.io/v1', apiKey: 'sk', modelName: 'music-2.6', prompt: 'x' })).rejects.toThrow(/auth failed|1004|音乐/);
  });
  it('空 prompt 且空 lyrics 抛错（付费前置守卫）', async () => {
    await expect(generateMusic({ baseUrl: 'https://api.minimax.io/v1', apiKey: 'sk', modelName: 'music-2.6', prompt: '  ' })).rejects.toThrow();
  });
});

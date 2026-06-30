import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitAndPollArkVideo, parseArkVideoTask } from '../../../src/host/services/media/videoGenerationService';

function stubFetch(responses: any[], calls: { url: string; body?: string }[]) {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
    calls.push({ url: String(url), body: init?.body });
    return Promise.resolve(responses.shift());
  }));
}

describe('parseArkVideoTask', () => {
  it('抽 id/status/content.video_url', () => {
    const r = parseArkVideoTask({ id: 't1', status: 'succeeded', content: { video_url: 'https://v/u.mp4' } });
    expect(r).toEqual({ id: 't1', status: 'succeeded', url: 'https://v/u.mp4', message: undefined });
  });
  it('非对象返回空', () => {
    expect(parseArkVideoTask(null)).toEqual({});
  });
});

describe('submitAndPollArkVideo', () => {
  const sig = new AbortController().signal;
  afterEach(() => vi.unstubAllGlobals());

  it('t2v：建任务→poll→取 content.video_url；body 结构化 + 仅 text 项', async () => {
    const calls: { url: string; body?: string }[] = [];
    stubFetch([
      { ok: true, json: async () => ({ id: 'task1' }) },
      { ok: true, json: async () => ({ id: 'task1', status: 'succeeded', content: { video_url: 'https://v/u.mp4' } }) },
    ], calls);
    const r = await submitAndPollArkVideo('ark-key',
      { model: 'doubao-seedance-2-0-260128', mode: 't2v', prompt: 'a cat', durationSec: 5 },
      sig, { pollIntervalMs: 1 });
    expect(r.url).toBe('https://v/u.mp4');
    const body = JSON.parse(calls[0].body!);
    expect(calls[0].url).toContain('/contents/generations/tasks');
    expect(body.model).toBe('doubao-seedance-2-0-260128');
    expect(body.content).toEqual([{ type: 'text', text: 'a cat' }]);
    expect(body.duration).toBe(5);
    expect(body.watermark).toBe(false);
    expect(typeof body.resolution).toBe('string');
  });

  it('i2v：content 带 image_url 项', async () => {
    const calls: { url: string; body?: string }[] = [];
    stubFetch([
      { ok: true, json: async () => ({ id: 'task2' }) },
      { ok: true, json: async () => ({ id: 'task2', status: 'succeeded', content: { video_url: 'https://v/i.mp4' } }) },
    ], calls);
    await submitAndPollArkVideo('ark-key',
      { model: 'doubao-seedance-2-0-260128', mode: 'i2v', prompt: 'move', imageDataUrl: 'data:image/png;base64,AAA', durationSec: 5 },
      sig, { pollIntervalMs: 1 });
    const body = JSON.parse(calls[0].body!);
    expect(body.content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
  });

  it('status=failed → 抛错', async () => {
    stubFetch([
      { ok: true, json: async () => ({ id: 't' }) },
      { ok: true, json: async () => ({ id: 't', status: 'failed', error: { message: 'nsfw' } }) },
    ], []);
    await expect(submitAndPollArkVideo('k', { model: 'm', mode: 't2v', prompt: 'x', durationSec: 5 }, sig, { pollIntervalMs: 1 })).rejects.toThrow();
  });

  it('status=expired → 抛错', async () => {
    stubFetch([
      { ok: true, json: async () => ({ id: 't' }) },
      { ok: true, json: async () => ({ id: 't', status: 'expired' }) },
    ], []);
    await expect(submitAndPollArkVideo('k', { model: 'm', mode: 't2v', prompt: 'x', durationSec: 5 }, sig, { pollIntervalMs: 1 })).rejects.toThrow();
  });

  it('succeeded 但缺 video_url → 抛错', async () => {
    stubFetch([
      { ok: true, json: async () => ({ id: 't' }) },
      { ok: true, json: async () => ({ id: 't', status: 'succeeded', content: {} }) },
    ], []);
    await expect(submitAndPollArkVideo('k', { model: 'm', mode: 't2v', prompt: 'x', durationSec: 5 }, sig, { pollIntervalMs: 1 })).rejects.toThrow();
  });

  it('建任务未返回 id → 抛错', async () => {
    stubFetch([{ ok: true, json: async () => ({}) }], []);
    await expect(submitAndPollArkVideo('k', { model: 'm', mode: 't2v', prompt: 'x', durationSec: 5 }, sig, { pollIntervalMs: 1 })).rejects.toThrow();
  });

  it('建任务 HTTP 非 2xx → 抛错', async () => {
    stubFetch([{ ok: false, status: 401, text: async () => 'unauthorized' }], []);
    await expect(submitAndPollArkVideo('bad', { model: 'm', mode: 't2v', prompt: 'x', durationSec: 5 }, sig, { pollIntervalMs: 1 })).rejects.toThrow();
  });
});

import { generateVideo } from '../../../src/host/services/media/videoGenerationService';

describe('generateVideo → ark 路由', () => {
  const orig = process.env.ARK_API_KEY;
  beforeEach(() => { process.env.ARK_API_KEY = 'ark-key'; });
  afterEach(() => { vi.unstubAllGlobals(); if (orig === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = orig; });

  it('provider=ark 走 Ark 引擎并回 url + actualModel', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ id: 'x', status: 'succeeded', content: { video_url: 'https://v/a.mp4' } }) })));
    const r = await generateVideo({ model: 'doubao-seedance-2-0-260128', mode: 't2v', prompt: 'a cat', durationSec: 5 });
    expect(r.url).toBe('https://v/a.mp4');
    expect(r.actualModel).toBe('doubao-seedance-2-0-260128');
  });

  it('缺 key 抛错且不发请求', async () => {
    delete process.env.ARK_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(generateVideo({ model: 'doubao-seedance-2-0-260128', mode: 't2v', prompt: 'a cat', durationSec: 5 })).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const axiosMock = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: (cfg: unknown) => axiosMock(cfg) }));
const getHttpsAgent = vi.hoisted(() => vi.fn(() => 'AGENT'));
vi.mock('../../../src/host/model/providers/providerHttp', () => ({ getHttpsAgent }));

import { veoRequest, isGoogleApiUrl } from '../../../src/host/services/media/veoFetch';

describe('isGoogleApiUrl', () => {
  it('仅 https + *.googleapis.com 放行', () => {
    expect(isGoogleApiUrl('https://generativelanguage.googleapis.com/v1beta/x')).toBe(true);
    expect(isGoogleApiUrl('http://generativelanguage.googleapis.com/x')).toBe(false);
    expect(isGoogleApiUrl('https://evil.com/x')).toBe(false);
    expect(isGoogleApiUrl('https://169.254.169.254/')).toBe(false);
  });
});

describe('veoRequest', () => {
  beforeEach(() => { axiosMock.mockReset(); getHttpsAgent.mockClear(); });

  it('JSON：带 x-goog-api-key 头 + 经 gemini 代理 agent + maxRedirects:0', async () => {
    axiosMock.mockResolvedValue({ status: 200, data: { name: 'op/1' } });
    const r = await veoRequest('https://generativelanguage.googleapis.com/v1beta/m:predictLongRunning', {
      method: 'POST', apiKey: 'k', body: { instances: [] }, timeoutMs: 1000,
    });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ name: 'op/1' });
    const cfg = axiosMock.mock.calls[0][0];
    expect(cfg.headers['x-goog-api-key']).toBe('k');
    expect(cfg.httpsAgent).toBe('AGENT');
    expect(cfg.maxRedirects).toBe(0);
    expect(getHttpsAgent).toHaveBeenCalledWith(expect.any(String), 'gemini');
  });

  it('arraybuffer：返回 Buffer', async () => {
    axiosMock.mockResolvedValue({ status: 200, data: new Uint8Array([1, 2, 3]).buffer });
    const r = await veoRequest('https://x.googleapis.com/f', { apiKey: 'k', responseType: 'arraybuffer', timeoutMs: 1000 });
    expect(Buffer.isBuffer(r.buffer)).toBe(true);
    expect(r.buffer!.length).toBe(3);
  });

  it('3xx 不跟随：status 原样返回（ok=false）', async () => {
    axiosMock.mockResolvedValue({ status: 302, data: '' });
    const r = await veoRequest('https://x.googleapis.com/f', { apiKey: 'k', timeoutMs: 1000 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(302);
  });
});

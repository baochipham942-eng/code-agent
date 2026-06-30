// Veo（Google Gemini API）专用代理 fetch。Veo 是国际端点，必须经代理：node 内置 fetch 不认
// HTTPS_PROXY，故不复用 imageGenerationService 的裸 fetchWithAbort，改用 axios + getHttpsAgent
// （与聊天 gemini provider 同款代理；gemini 在 OVERSEAS_PROVIDERS 必走代理）。maxRedirects:0 防
// SSRF-via-redirect（与 downloadVideoAsBuffer 的 redirect:'manual' 同义）。
import axios from 'axios';
import { getHttpsAgent } from '../../model/providers/providerHttp';

const GOOGLE_HOST_SUFFIX = '.googleapis.com';

/** 仅 https + *.googleapis.com 放行（下载 URI 的 SSRF 白名单）。 */
export function isGoogleApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.host.toLowerCase().endsWith(GOOGLE_HOST_SUFFIX);
  } catch {
    return false;
  }
}

export interface VeoRequestOptions {
  method?: 'GET' | 'POST';
  apiKey: string;
  body?: unknown;
  responseType?: 'json' | 'arraybuffer';
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface VeoResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  buffer?: Buffer;
}

export async function veoRequest(url: string, opts: VeoRequestOptions): Promise<VeoResponse> {
  const responseType = opts.responseType ?? 'json';
  const resp = await axios({
    url,
    method: opts.method ?? 'GET',
    headers: {
      'x-goog-api-key': opts.apiKey,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    data: opts.body,
    timeout: opts.timeoutMs,
    httpsAgent: getHttpsAgent(url, 'gemini'),
    responseType: responseType === 'arraybuffer' ? 'arraybuffer' : 'json',
    maxRedirects: 0,            // 不跟随 3xx（SSRF-via-redirect 防护）
    validateStatus: () => true, // 自己判 status，3xx/4xx 也正常返回不抛
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    signal: opts.signal,
  });
  const ok = resp.status >= 200 && resp.status < 300;
  if (responseType === 'arraybuffer') {
    return { ok, status: resp.status, buffer: Buffer.from(resp.data as ArrayBuffer) };
  }
  return { ok, status: resp.status, data: resp.data };
}

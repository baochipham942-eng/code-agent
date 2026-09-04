import axios, { type AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  PROVIDER_TIMEOUT,
  isDirectConnectHost,
  normalizeProviderId,
  providerNeedsProxy,
} from '../../../shared/constants';
import type { ProxyMode } from '../../../shared/contract/settings';

let _cachedProxyUrl: string | undefined;
let _cachedAgent: HttpsProxyAgent<string> | undefined;

const _proxyModeOverrides = new Map<string, ProxyMode>();

export function setProviderProxyOverrides(map: Record<string, ProxyMode>): void {
  _proxyModeOverrides.clear();
  for (const [provider, mode] of Object.entries(map)) {
    if (mode === 'direct' || mode === 'proxy') {
      _proxyModeOverrides.set(normalizeProviderId(provider) ?? provider, mode);
    }
  }
}

export function getHttpsAgent(targetUrl?: string, provider?: string): HttpsProxyAgent<string> | undefined {
  const url = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (!url || process.env.NO_PROXY === 'true' || process.env.DISABLE_PROXY === 'true') {
    return undefined;
  }
  if (provider !== undefined) {
    const override = _proxyModeOverrides.get(normalizeProviderId(provider) ?? provider);
    if (override === 'direct') return undefined;
    if (override !== 'proxy' && !providerNeedsProxy(provider, targetUrl)) return undefined;
  } else if (targetUrl && isDirectConnectHost(targetUrl)) {
    return undefined;
  }
  if (url !== _cachedProxyUrl) {
    _cachedProxyUrl = url;
    _cachedAgent = new HttpsProxyAgent(url);
  }
  return _cachedAgent;
}

/** @deprecated 模块加载时快照，运行时改 env 不生效。请用 `getHttpsAgent()`。 */
export const httpsAgent = getHttpsAgent();

/**
 * 销毁共享 keep-alive agent 并清缓存（下一次 getHttpsAgent 会按需重建）。
 * 长跑进程收尾时调用：agent 持有的空闲 TLS socket 会 ref 住事件循环，
 * 不销毁进程退不掉（N-EVAL-CI-NOEXIT 持有者点名的 TLSWRAP）。
 */
export function destroySharedHttpsAgent(): void {
  if (_cachedAgent) {
    _cachedAgent.destroy();
    _cachedAgent = undefined;
    _cachedProxyUrl = undefined;
  }
}

export function normalizeClaudeBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export interface ElectronFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  provider?: string;
  /** 保留响应体供协议专用 SSE parser 消费；普通请求仍按 JSON 缓冲。 */
  stream?: boolean;
}

export interface ElectronFetchResponse<T = unknown> {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<T>;
  body?: ReadableStream<Uint8Array>;
}

function isNodeReadable(data: unknown): data is NodeJS.ReadableStream {
  return !!data && typeof (data as NodeJS.ReadableStream).pipe === 'function';
}

async function drainBodyText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (isNodeReadable(data)) {
    const chunks: Buffer[] = [];
    for await (const chunk of data as unknown as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return JSON.stringify(data);
}

export async function electronFetch<T = unknown>(
  url: string,
  options: ElectronFetchOptions,
): Promise<ElectronFetchResponse<T>> {
  try {
    const response: AxiosResponse<T> = await axios({
      url,
      method: options.method || 'GET',
      headers: options.headers,
      data: options.body ? (JSON.parse(options.body) as unknown) : undefined,
      timeout: options.timeoutMs ?? PROVIDER_TIMEOUT,
      httpsAgent: getHttpsAgent(url, options.provider),
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      ...(options.stream ? { responseType: 'stream' as const } : {}),
      signal: options.signal,
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      // stream:true 时 axios 的 response.data 是 Node Readable——包括非 2xx 的错误响应
      // （validateStatus 全放行）。直接 JSON.stringify 会得到 {"_events":{},...} 的流壳，
      // 上游拒绝原文全丢（N-MODELERR）；必须先把流读完再返回文本。
      text: async () => drainBodyText(response.data),
      json: async (): Promise<T> => isNodeReadable(response.data)
        ? JSON.parse(await drainBodyText(response.data)) as T
        : response.data,
      // Axios 在 Node/Electron stream adapter 下返回 NodeJS.ReadableStream；保留 fetch
      // 兼容的 public contract，协议侧再按运行时形态读取。
      ...(options.stream ? { body: response.data as unknown as ReadableStream<Uint8Array> } : {}),
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (axios.isCancel(error) || (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError'))) {
      throw new Error('Request was cancelled', { cause: error });
    }
    throw new Error(`Network request failed: ${errMsg}`, { cause: error });
  }
}

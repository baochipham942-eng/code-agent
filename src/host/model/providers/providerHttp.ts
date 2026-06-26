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
}

export interface ElectronFetchResponse<T = unknown> {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<T>;
  body?: ReadableStream<Uint8Array>;
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
      signal: options.signal,
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
      json: async (): Promise<T> => response.data,
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (axios.isCancel(error) || (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError'))) {
      throw new Error('Request was cancelled', { cause: error });
    }
    throw new Error(`Network request failed: ${errMsg}`, { cause: error });
  }
}

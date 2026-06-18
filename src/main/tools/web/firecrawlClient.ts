// ============================================================================
// Firecrawl web data client
// ============================================================================

import type { getConfigService } from '../../services/core/configService';
import { SEARCH_API_ENDPOINTS } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('FirecrawlClient');

const DEFAULT_TIMEOUT_MS = 30_000;

/** keyless 限流时引导用户配置 key 的可操作提示 */
const FIRECRAWL_RATE_LIMIT_HINT =
  '（keyless 额度受限，在「设置 > Service API Keys」配置 FIRECRAWL_API_KEY 可获得稳定额度）';

/** 判断错误是否为限流（HTTP 429 或 rate limit 文案） */
export function isFirecrawlRateLimited(error: string): boolean {
  return /\b429\b/.test(error) || /rate limit|too many requests/i.test(error);
}

/** 对限流错误附加可操作提示：仅在 keyless（未配置 key）时建议配置 key */
export function annotateFirecrawlError(error: string, hasApiKey: boolean): string {
  if (!hasApiKey && isFirecrawlRateLimited(error)) {
    return `${error} ${FIRECRAWL_RATE_LIMIT_HINT}`;
  }
  return error;
}

export type FirecrawlCredentialMode = 'authenticated' | 'keyless';

export interface FirecrawlScrapeSuccess {
  ok: true;
  markdown: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  scrapeId?: string;
  cached?: boolean;
  creditsUsed?: number;
  credentialMode: FirecrawlCredentialMode;
}

export interface FirecrawlSearchSuccess {
  ok: true;
  results: Array<{
    title: string;
    url: string;
    snippet?: string;
    age?: string;
  }>;
  searchId?: string;
  creditsUsed?: number;
  credentialMode: FirecrawlCredentialMode;
}

export type FirecrawlScrapeResult = FirecrawlScrapeSuccess | { ok: false; error: string };
export type FirecrawlSearchResult = FirecrawlSearchSuccess | { ok: false; error: string };

interface FirecrawlClientOptions {
  configService?: ReturnType<typeof getConfigService>;
  timeoutMs?: number;
}

interface FirecrawlScrapeResponse {
  success?: boolean;
  code?: string;
  error?: string;
  data?: {
    markdown?: string;
    metadata?: {
      scrapeId?: string;
      sourceURL?: string;
      url?: string;
      statusCode?: number;
      contentType?: string;
      cacheState?: string;
      creditsUsed?: number;
    };
  };
}

interface FirecrawlSearchResponse {
  success?: boolean;
  code?: string;
  error?: string;
  id?: string;
  creditsUsed?: number;
  data?: {
    web?: Array<{
      title?: string;
      url?: string;
      description?: string;
      snippet?: string;
      markdown?: string;
      publishedDate?: string;
    }>;
  };
}

export function isFirecrawlDefaultEnabled(): boolean {
  return process.env.CODE_AGENT_DISABLE_FIRECRAWL_DEFAULT !== '1'
    && process.env.CODE_AGENT_WEB_DATA_PRIMARY !== 'native'
    && process.env.CODE_AGENT_WEB_DATA_PROVIDER !== 'native';
}

export function isPrivateOrLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    const normalized = hostname.toLowerCase();
    if (
      normalized === 'localhost'
      || normalized === '127.0.0.1'
      || normalized === '::1'
      || normalized.endsWith('.local')
      || normalized.endsWith('.internal')
    ) {
      return true;
    }
    if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)) {
      return true;
    }
    const private172 = normalized.match(/^172\.(\d+)\./);
    if (private172) {
      const secondOctet = Number(private172[1]);
      if (secondOctet >= 16 && secondOctet <= 31) return true;
    }
    return /^169\.254\./.test(normalized);
  } catch {
    return true;
  }
}

function looksLikeRawDataUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (/\.(json|ndjson|xml|csv|txt|yaml|yml)(?:$|\?)/.test(pathname)) return true;
    const format = parsed.searchParams.get('format') || parsed.searchParams.get('output');
    return /^(json|xml|csv|text|txt)$/i.test(format || '');
  } catch {
    return false;
  }
}

export function shouldUseFirecrawlForUrl(url: string): boolean {
  if (!isFirecrawlDefaultEnabled()) return false;
  return !isPrivateOrLocalUrl(url) && !looksLikeRawDataUrl(url);
}

function getFirecrawlApiKey(configService: ReturnType<typeof getConfigService> | undefined): string {
  return configService?.getServiceApiKey?.('firecrawl') || process.env.FIRECRAWL_API_KEY || '';
}

function buildFirecrawlHeaders(
  configService: ReturnType<typeof getConfigService> | undefined,
): { headers: Record<string, string>; credentialMode: FirecrawlCredentialMode } {
  const apiKey = getFirecrawlApiKey(configService);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    return { headers, credentialMode: 'authenticated' };
  }
  return { headers, credentialMode: 'keyless' };
}

async function postFirecrawl<T>(
  endpoint: string,
  body: Record<string, unknown>,
  options: FirecrawlClientOptions,
): Promise<{ ok: true; data: T; credentialMode: FirecrawlCredentialMode } | { ok: false; error: string }> {
  const { headers, credentialMode } = buildFirecrawlHeaders(options.configService);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const text = await response.text();
  let parsed: T | undefined;
  try {
    parsed = text ? JSON.parse(text) as T : undefined;
  } catch {
    // Keep raw text in the HTTP error below.
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`,
    };
  }

  if (!parsed) {
    return { ok: false, error: 'Empty Firecrawl response' };
  }

  return { ok: true, data: parsed, credentialMode };
}

export async function scrapeWithFirecrawl(
  url: string,
  options: FirecrawlClientOptions = {},
): Promise<FirecrawlScrapeResult> {
  if (!shouldUseFirecrawlForUrl(url)) {
    return { ok: false, error: 'Firecrawl disabled or URL is local/private' };
  }

  const response = await postFirecrawl<FirecrawlScrapeResponse>(
    SEARCH_API_ENDPOINTS.firecrawlScrape,
    {
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      pdfOptions: { maxPages: 100 },
    },
    options,
  );

  const hasApiKey = Boolean(getFirecrawlApiKey(options.configService));
  if (!response.ok) {
    return { ok: false, error: annotateFirecrawlError(response.error, hasApiKey) };
  }
  const payload = response.data;
  if (payload.success === false) {
    return { ok: false, error: payload.error || payload.code || 'Firecrawl scrape failed' };
  }

  const markdown = payload.data?.markdown?.trim();
  if (!markdown) {
    return { ok: false, error: 'Firecrawl returned empty markdown' };
  }

  const metadata = payload.data?.metadata ?? {};
  logger.debug('Firecrawl scrape ok', {
    creditsUsed: metadata.creditsUsed,
    credentialMode: response.credentialMode,
    cached: metadata.cacheState === 'hit',
  });
  return {
    ok: true,
    markdown,
    finalUrl: metadata.url || metadata.sourceURL || url,
    statusCode: metadata.statusCode ?? 200,
    contentType: metadata.contentType || 'text/markdown',
    scrapeId: metadata.scrapeId,
    cached: metadata.cacheState === 'hit',
    creditsUsed: metadata.creditsUsed,
    credentialMode: response.credentialMode,
  };
}

export async function searchWithFirecrawl(
  query: string,
  maxResults: number,
  options: FirecrawlClientOptions & {
    includeDomains?: string[];
    excludeDomains?: string[];
    recency?: string;
  } = {},
): Promise<FirecrawlSearchResult> {
  if (!isFirecrawlDefaultEnabled()) {
    return { ok: false, error: 'Firecrawl default web data provider is disabled' };
  }

  const body: Record<string, unknown> = {
    query,
    limit: maxResults,
    sources: [{ type: 'web' }],
  };
  if (options.includeDomains?.length) body.includeDomains = options.includeDomains;
  if (options.excludeDomains?.length) body.excludeDomains = options.excludeDomains;
  const tbs: Record<string, string> = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m' };
  if (options.recency && tbs[options.recency]) body.tbs = tbs[options.recency];

  const response = await postFirecrawl<FirecrawlSearchResponse>(
    SEARCH_API_ENDPOINTS.firecrawlSearch,
    body,
    options,
  );

  const hasApiKey = Boolean(getFirecrawlApiKey(options.configService));
  if (!response.ok) {
    return { ok: false, error: annotateFirecrawlError(response.error, hasApiKey) };
  }
  const payload = response.data;
  if (payload.success === false) {
    return { ok: false, error: payload.error || payload.code || 'Firecrawl search failed' };
  }

  logger.debug('Firecrawl search ok', {
    creditsUsed: payload.creditsUsed,
    credentialMode: response.credentialMode,
  });
  const webResults = payload.data?.web ?? [];
  return {
    ok: true,
    results: webResults
      .filter((item) => typeof item.url === 'string' && item.url.length > 0)
      .map((item) => ({
        title: item.title || item.url!,
        url: item.url!,
        snippet: item.description || item.snippet || item.markdown?.slice(0, 500),
        age: item.publishedDate,
      })),
    searchId: payload.id,
    creditsUsed: payload.creditsUsed,
    credentialMode: response.credentialMode,
  };
}

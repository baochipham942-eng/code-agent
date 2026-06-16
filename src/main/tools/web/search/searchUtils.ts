// ============================================================================
// Web Search Utilities
// Circuit breaker, formatting, deduplication, domain filtering
// ============================================================================

import type { ToolExecutionResult } from '../../types';
import type { SearchResult, DomainFilter } from './searchTypes';
import { CLOUD_ENDPOINTS, SEARCH_API_ENDPOINTS } from '../../../../shared/constants';
import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('WebSearch');

// ============================================================================
// Constants
// ============================================================================

export const CLOUD_SEARCH_URL = `${CLOUD_ENDPOINTS.tools}?action=search`;
export const BRAVE_SEARCH_URL = SEARCH_API_ENDPOINTS.brave;
export const EXA_SEARCH_URL = SEARCH_API_ENDPOINTS.exa;
export const PERPLEXITY_API_URL = SEARCH_API_ENDPOINTS.perplexity;
export const TAVILY_SEARCH_URL = SEARCH_API_ENDPOINTS.tavily;
export const OPENAI_RESPONSES_URL = SEARCH_API_ENDPOINTS.openai;

export const SEARCH_PROVIDER_SETUP_MESSAGE = [
  '当前没有可用的联网搜索源。',
  '模型 API Key 只负责模型推理；Claude、Gemini、Grok 等模型 key 不会自动启用 WebSearch。',
  '要启用联网搜索，请在「设置 > Service API Keys」至少配置一个搜索服务 key：',
  '- Brave Search：通用网页搜索，适合作默认共享源。',
  '- OpenAI：Responses web_search；如果使用 NewAPI/relay，需要同时配置 baseUrl。',
  '- EXA：技术文档和语义搜索。',
  '- Tavily：结构化搜索和网页摘要。',
  '- Perplexity：带 AI 摘要，但额度耗尽时会被临时跳过。',
].join('\n');

export const SEARCH_FAILURE_GUIDANCE = [
  '联网搜索没有拿到可用结果。',
  '如果错误里出现 quota / insufficient_quota / billing details，表示该搜索源额度已耗尽；请换一个搜索源，或在「设置 > Service API Keys」配置自己的 Brave、OpenAI、EXA、Tavily 或 Perplexity key。',
].join('\n');

// Domains to skip when auto-extracting (search engines themselves)
export const SEARCH_ENGINE_DOMAINS = [
  'google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com',
  'baidu.com', 'yandex.com', 'brave.com',
];

// Domains that consistently block automated extraction (403/paywall)
export const AUTO_EXTRACT_BLOCKED_DOMAINS = [
  'medium.com',
  'bloomberg.com',
  'wsj.com',
  'nytimes.com',
  'ft.com',
  'linkedin.com',
];

// Runtime domain failure tracker — domains that fail during this session
const domainFailureCount: Record<string, number> = {};
const DOMAIN_FAILURE_THRESHOLD = 2;

/**
 * Record a domain extraction failure. After DOMAIN_FAILURE_THRESHOLD failures,
 * the domain is considered blocked for the rest of this session.
 */
export function recordDomainFailure(url: string): void {
  try {
    const hostname = new URL(url).hostname;
    domainFailureCount[hostname] = (domainFailureCount[hostname] || 0) + 1;
    if (domainFailureCount[hostname] === DOMAIN_FAILURE_THRESHOLD) {
      logger.info(`Domain auto-blocked after ${DOMAIN_FAILURE_THRESHOLD} failures: ${hostname}`);
    }
  } catch { /* ignore */ }
}

/**
 * Check if a domain should be skipped for auto-extraction.
 * Combines static blocklist + runtime failure tracking.
 */
export function isDomainBlocked(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    if (AUTO_EXTRACT_BLOCKED_DOMAINS.some(d => hostname.endsWith(d))) return true;
    if ((domainFailureCount[hostname] || 0) >= DOMAIN_FAILURE_THRESHOLD) return true;
  } catch { /* ignore */ }
  return false;
}

// Preferred domains for auto-extraction (official/authoritative sources)
export const PREFERRED_EXTRACT_DOMAINS = [
  'github.com',
  'docs.anthropic.com',
  'modelcontextprotocol.io',
  'spec.modelcontextprotocol.io',
  'openai.com',
  'arxiv.org',
  'wikipedia.org',
  'developer.mozilla.org',
  'docs.python.org',
  'docs.microsoft.com',
  'cloud.google.com',
];

// ============================================================================
// Circuit Breaker for Rate-Limited Sources
// ============================================================================

/** source name -> cooldown expiry timestamp (ms) */
const circuitBreaker: Record<string, number> = {};
const RATE_LIMIT_CIRCUIT_BREAKER_COOLDOWN = 10 * 60 * 1000; // 10 minutes
const QUOTA_CIRCUIT_BREAKER_COOLDOWN = 24 * 60 * 60 * 1000; // 24 hours

// Quota / auth exhaustion: provider is out of credit or the key is rejected.
// Covers 402 (billing), 432 (Tavily plan-limit) and 401 (unauthorized / expired key) —
// none of these self-heal within a session, so we skip the source for a long cooldown
// instead of re-hitting it every round.
const QUOTA_ERROR_PATTERN =
  /insufficient[_\s-]?quota|quota\s+(?:exceeded|exhausted)|exceeded\s+(?:your\s+)?current\s+quota|insufficient\s+(?:balance|credits?)|billing\s+details|unauthorized|invalid\s+api\s+key|HTTP\s+40[12]|\b40[12]\b|HTTP\s+432|\b432\b/i;
const RATE_LIMIT_ERROR_PATTERN = /HTTP\s+429|\b429\b|rate[_\s-]?limit|too many requests/i;

/**
 * Check if a source is currently circuit-broken.
 * Returns remaining cooldown in ms, or 0 if source is available.
 */
export function getCircuitBreakerRemaining(source: string): number {
  const until = circuitBreaker[source];
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    delete circuitBreaker[source];
    return 0;
  }
  return remaining;
}

/**
 * Trip the circuit breaker for a source after receiving a rate/quota failure.
 */
export function tripCircuitBreaker(source: string, cooldownMs = RATE_LIMIT_CIRCUIT_BREAKER_COOLDOWN): void {
  circuitBreaker[source] = Date.now() + cooldownMs;
  logger.warn('Circuit breaker tripped for source', {
    source,
    cooldownMs,
    resumeAt: new Date(circuitBreaker[source]).toISOString(),
  });
}

export function getSearchErrorCircuitBreakerCooldown(error: string | undefined): number | null {
  if (!error) return null;
  if (QUOTA_ERROR_PATTERN.test(error)) return QUOTA_CIRCUIT_BREAKER_COOLDOWN;
  if (RATE_LIMIT_ERROR_PATTERN.test(error)) return RATE_LIMIT_CIRCUIT_BREAKER_COOLDOWN;
  return null;
}

// ============================================================================
// Formatting
// ============================================================================

/** Convert ISO date string to human-readable relative age (e.g. "2 days ago") */
export function formatAge(dateStr: string): string | undefined {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return undefined;
    const diffMs = Date.now() - d.getTime();
    const diffHours = Math.floor(diffMs / 3600000);
    if (diffHours < 1) return 'just now';
    if (diffHours < 24) return `${diffHours} hours ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return '1 day ago';
    if (diffDays < 30) return `${diffDays} days ago`;
    const diffMonths = Math.floor(diffDays / 30);
    return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
  } catch {
    return undefined;
  }
}

/**
 * Convert search results to a compact markdown list with descriptions.
 * Each item includes title, age, snippet, and URL.
 */
export function formatAsTable(searchResult: ToolExecutionResult): string {
  const resultData = searchResult.result as { results?: SearchResult[]; sources?: string[]; duration?: number } | undefined;
  const results = resultData?.results || [];

  if (results.length === 0) {
    return 'No results found.';
  }

  const lines: string[] = [];

  results.forEach((item, i) => {
    const title = (item.title || 'Untitled').substring(0, 100);
    const age = item.age ? ` (${item.age})` : '';
    lines.push(`### ${i + 1}. ${title}${age}`);
    const snippet = item.snippet || item.description || '';
    if (snippet) {
      lines.push(snippet.substring(0, 200));
    }
    lines.push(item.url);
    lines.push('');
  });

  if (resultData?.sources) {
    lines.push(`---\nSources: ${resultData.sources.join(', ')}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Deduplication
// ============================================================================

/**
 * Normalize title for dedup: lowercase, collapse whitespace, take first 60 chars.
 * This catches identical articles syndicated across different sites
 * where full titles may differ slightly (trailing punctuation, etc.).
 */
export function normalizeTitleForDedup(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 60);
}

/**
 * Remove duplicate results from a ToolExecutionResult in-place.
 * Deduplicates by URL and by normalized title prefix (case-insensitive, first 60 chars).
 */
export function deduplicateResults(searchResult: ToolExecutionResult): void {
  const resultData = searchResult.result as { results?: SearchResult[]; source?: string; sources?: string[]; duration?: number } | undefined;
  if (!resultData?.results || resultData.results.length === 0) return;

  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const before = resultData.results.length;

  resultData.results = resultData.results.filter(item => {
    if (seenUrls.has(item.url)) return false;
    const normalizedTitle = normalizeTitleForDedup(item.title || '');
    if (normalizedTitle && seenTitles.has(normalizedTitle)) return false;
    seenUrls.add(item.url);
    if (normalizedTitle) seenTitles.add(normalizedTitle);
    return true;
  });

  const removed = before - resultData.results.length;
  if (removed > 0) {
    logger.info(`Deduplicated: removed ${removed} duplicate results (${before} → ${resultData.results.length})`);

    // Rebuild output to match filtered results (fixes serial path timing issue)
    const outputParts: string[] = [];
    const source = resultData.source || (resultData.sources || []).join(', ') || 'search';
    outputParts.push(`Search results for deduplicated results (via ${source})`);
    outputParts.push('');
    resultData.results.forEach((item, index) => {
      const snippet = item.snippet || item.description || '';
      outputParts.push(`${index + 1}. ${item.title}${item.age ? ` (${item.age})` : ''}`);
      outputParts.push(`   ${item.url}`);
      if (snippet) outputParts.push(`   ${snippet}`);
      outputParts.push('');
    });
    searchResult.output = outputParts.join('\n');
  }
}

// ============================================================================
// Domain Filter Helpers
// ============================================================================

/**
 * Build domain constraint string for query-based filtering (Brave, Perplexity).
 * e.g., "site:docs.python.org site:github.com -site:pinterest.com"
 */
export function buildDomainQuerySuffix(domainFilter?: DomainFilter): string {
  if (!domainFilter) return '';
  const parts: string[] = [];
  if (domainFilter.allowed && domainFilter.allowed.length > 0) {
    parts.push(domainFilter.allowed.map(d => `site:${d}`).join(' OR '));
  }
  if (domainFilter.blocked && domainFilter.blocked.length > 0) {
    parts.push(...domainFilter.blocked.map(d => `-site:${d}`));
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

// ============================================================================
// Shared Fetch Utility — caching, timeout, retry, redirect classification
// Used by webFetch and webSearch auto-extract
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import { WEB_FETCH } from '../../../shared/constants';

const logger = createLogger('FetchDocument');

// ============================================================================
// Types
// ============================================================================

export interface FetchDocumentResult {
  content: string;
  contentType: string;
  /** Final URL after redirects */
  finalUrl: string;
  /** True if redirect crossed to a different domain */
  crossDomainRedirect: boolean;
  statusCode: number;
  fromCache: boolean;
}

// ============================================================================
// LRU Cache (module-level)
// ============================================================================

interface CacheEntry {
  result: FetchDocumentResult;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(url: string): FetchDocumentResult | null {
  const entry = cache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > WEB_FETCH.CACHE_TTL) {
    cache.delete(url);
    return null;
  }
  return { ...entry.result, fromCache: true };
}

function setCache(url: string, result: FetchDocumentResult): void {
  // Evict oldest entries if over capacity
  if (cache.size >= WEB_FETCH.CACHE_MAX_ENTRIES) {
    // Delete the oldest entry (first key in insertion order)
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(url, { result, timestamp: Date.now() });
}

// ============================================================================
// Helpers
// ============================================================================

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isRetryableStatus(status: number): boolean {
  return (WEB_FETCH.RETRYABLE_STATUS as readonly number[]).includes(status);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Main Fetch Function
// ============================================================================

/**
 * Fetch a URL with caching, timeout, retry, and redirect classification.
 *
 * - Accept header prefers markdown (Cloudflare Markdown for Agents etc.)
 * - 30s timeout via AbortSignal
 * - LRU cache (TTL=15min, max 50 entries), keyed by final URL
 * - Retries once on 429/5xx with 1s delay
 * - Classifies cross-domain redirects for caller decision
 */
export async function fetchDocument(url: string): Promise<FetchDocumentResult> {
  // Check cache first
  const cached = getCached(url);
  if (cached) {
    logger.info(`Cache hit: ${url}`);
    return cached;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= WEB_FETCH.MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        logger.info(`Retry #${attempt} for ${url}`);
        await delay(WEB_FETCH.RETRY_DELAY);
      }

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CodeAgent/1.0)',
          Accept: 'text/markdown, text/html, */*',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(WEB_FETCH.TIMEOUT),
      });

      // Retry on transient errors
      if (!response.ok && isRetryableStatus(response.status) && attempt < WEB_FETCH.MAX_RETRIES) {
        logger.warn(`Transient HTTP ${response.status} for ${url}, will retry`);
        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const content = await response.text();
      const finalUrl = response.url || url;

      // Classify redirect
      const requestDomain = extractDomain(url);
      const responseDomain = extractDomain(finalUrl);
      const crossDomainRedirect = requestDomain !== '' && responseDomain !== '' && requestDomain !== responseDomain;

      if (crossDomainRedirect) {
        logger.info(`Cross-domain redirect: ${requestDomain} → ${responseDomain}`);
      }

      const result: FetchDocumentResult = {
        content,
        contentType,
        finalUrl,
        crossDomainRedirect,
        statusCode: response.status,
        fromCache: false,
      };

      // Cache by both original URL and final URL
      setCache(url, result);
      if (finalUrl !== url) {
        setCache(finalUrl, result);
      }

      return result;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on non-transient errors (timeout, DNS, etc.)
      if (attempt >= WEB_FETCH.MAX_RETRIES) break;

      // Only retry if it looks transient
      const msg = lastError.message.toLowerCase();
      const isTransient = msg.includes('429') || msg.includes('500') || msg.includes('502')
        || msg.includes('503') || msg.includes('504') || msg.includes('econnreset')
        || msg.includes('socket hang up');

      if (!isTransient) break;

      logger.warn(`Transient error for ${url}: ${lastError.message}, will retry`);
    }
  }

  throw lastError || new Error(`Failed to fetch ${url}`);
}

/**
 * Clear the fetch cache (for testing or manual invalidation).
 */
export function clearFetchCache(): void {
  cache.clear();
}

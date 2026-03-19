// ============================================================================
// Content Extractor
// Auto-extract content from search result URLs
// ============================================================================

import type { ToolExecutionResult } from '../../types';
import type { SearchResult } from './searchTypes';
import {
  SEARCH_ENGINE_DOMAINS,
  isDomainBlocked,
  recordDomainFailure,
  PREFERRED_EXTRACT_DOMAINS,
} from './searchUtils';
import { smartHtmlToText, smartTruncate, buildExtractionPrompt } from '../htmlUtils';
import { fetchDocument } from '../fetchDocument';
import { createLogger } from '../../../services/infra/logger';

const logger = createLogger('WebSearch');

/**
 * Light model callback for auto-extract.
 * Prefers quickModel (GLM-4-Flash, free & fast) over main model to avoid
 * polluting the main model's fallback chain with extraction tasks.
 */
async function lightExtract(
  prompt: string,
  fallbackCallback?: (prompt: string) => Promise<string>,
): Promise<string> {
  try {
    const { quickTask, isQuickModelAvailable } = await import('../../../model/quickModel');
    if (isQuickModelAvailable()) {
      const result = await quickTask(prompt);
      if (result.success && result.content) return result.content;
    }
  } catch { /* quickModel not available, fall through */ }

  if (fallbackCallback) {
    return fallbackCallback(prompt);
  }
  throw new Error('No model available for extraction');
}

/**
 * After search completes, fetch top N result URLs and extract content via AI.
 * Uses shared fetchDocument() for caching, timeout, and retry.
 * Uses quickModel (light/free) for extraction to avoid main model fallback chain.
 */
export async function autoExtractFromResults(
  searchResult: ToolExecutionResult,
  query: string,
  extractCount: number,
  modelCallback: (prompt: string) => Promise<string>,
): Promise<string | null> {
  // Extract URLs from search results, filtering blocked domains and sorting by quality
  const resultData = searchResult.result as { results?: SearchResult[] } | undefined;
  const candidateUrls = (resultData?.results || [])
    .map(r => r.url)
    .filter(url => {
      try {
        const hostname = new URL(url).hostname;
        if (SEARCH_ENGINE_DOMAINS.some(d => hostname.endsWith(d))) return false;
        if (isDomainBlocked(url)) return false;
        return true;
      } catch {
        return false;
      }
    });

  // Sort: preferred authoritative domains first
  const urls = candidateUrls
    .sort((a, b) => {
      const aPreferred = PREFERRED_EXTRACT_DOMAINS.some(d => {
        try { return new URL(a).hostname.endsWith(d); } catch { return false; }
      }) ? 0 : 1;
      const bPreferred = PREFERRED_EXTRACT_DOMAINS.some(d => {
        try { return new URL(b).hostname.endsWith(d); } catch { return false; }
      }) ? 0 : 1;
      return aPreferred - bPreferred;
    })
    .slice(0, extractCount);

  if (urls.length === 0) return null;

  logger.info(`Auto-extracting content from ${urls.length} URLs`);

  let failedCount = 0;

  // Parallel fetch + extract using fetchDocument (benefits from caching)
  const extractPromises = urls.map(async (url): Promise<{ url: string; content: string } | null> => {
    try {
      const doc = await fetchDocument(url);

      // If response is already markdown, skip cheerio
      let text: string;
      if (doc.contentType.includes('text/markdown')) {
        text = doc.content;
      } else {
        text = smartHtmlToText(doc.content, doc.finalUrl);
      }
      if (text.length < 50) return null;

      // AI extraction — max 3000 chars per URL (uses light model to avoid main fallback chain)
      const extractionPrompt = buildExtractionPrompt(query, text, 3000);
      const extracted = await lightExtract(extractionPrompt, modelCallback);

      if (extracted && extracted.trim().length > 50) {
        return { url: doc.finalUrl, content: extracted.trim() };
      }

      // Fallback: smart truncate
      return { url: doc.finalUrl, content: smartTruncate(text, 3000) };
    } catch (err) {
      failedCount++;
      recordDomainFailure(url);
      logger.warn(`Auto-extract failed for ${url}:`, err instanceof Error ? err.message : err);
      return null;
    }
  });

  const results = await Promise.allSettled(extractPromises);
  const extractedParts: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      extractedParts.push(`## Extracted: ${result.value.url}`);
      extractedParts.push(result.value.content);
      extractedParts.push('');
    }
  }

  const successCount = extractedParts.length;
  logger.info(`Extracted ${successCount}/${urls.length} pages${failedCount > 0 ? ` (${failedCount} failed)` : ''}`);

  if (extractedParts.length === 0) return null;

  return `---\n# Auto-Extracted Content (${successCount}/${urls.length} pages)\n\n` + extractedParts.join('\n');
}

/**
 * CLI fallback for auto_extract: fetch + smartTruncate (no AI model needed).
 * Uses shared fetchDocument() for caching, timeout, and retry.
 */
export async function autoExtractFallback(
  searchResult: ToolExecutionResult,
  extractCount: number,
): Promise<string | null> {
  const resultData = searchResult.result as { results?: SearchResult[] } | undefined;
  const urls = (resultData?.results || [])
    .map(r => r.url)
    .filter(url => {
      try {
        const hostname = new URL(url).hostname;
        if (SEARCH_ENGINE_DOMAINS.some(d => hostname.endsWith(d))) return false;
        if (isDomainBlocked(url)) return false;
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, extractCount);

  if (urls.length === 0) return null;

  logger.info(`[CLI fallback] Auto-extracting from ${urls.length} URLs (no AI, smartTruncate)`);

  let failedCount = 0;

  const fetchPromises = urls.map(async (url): Promise<{ url: string; content: string } | null> => {
    try {
      const doc = await fetchDocument(url);

      // If response is already markdown, skip cheerio
      let text: string;
      if (doc.contentType.includes('text/markdown')) {
        text = doc.content;
      } else {
        text = smartHtmlToText(doc.content, doc.finalUrl);
      }
      if (text.length < 50) return null;

      // No AI available — just smartTruncate to 2000 chars
      return { url: doc.finalUrl, content: smartTruncate(text, 2000) };
    } catch (err) {
      failedCount++;
      recordDomainFailure(url);
      logger.warn(`[CLI fallback] Fetch failed for ${url}:`, err instanceof Error ? err.message : err);
      return null;
    }
  });

  const results = await Promise.allSettled(fetchPromises);
  const extractedParts: string[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      extractedParts.push(`## Page: ${result.value.url}`);
      extractedParts.push(result.value.content);
      extractedParts.push('');
    }
  }

  const successCount = extractedParts.length;
  logger.info(`[CLI fallback] Extracted ${successCount}/${urls.length} pages${failedCount > 0 ? ` (${failedCount} failed)` : ''}`);

  if (extractedParts.length === 0) return null;

  return `---\n# Fetched Page Content (${successCount}/${urls.length} pages)\n\n` + extractedParts.join('\n');
}

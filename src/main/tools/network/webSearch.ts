// ============================================================================
// Web Search Tool - Multi-source parallel web search
// Supports: Cloud Proxy, Perplexity, EXA, Brave Search
// P1: Domain filtering (allowed_domains / blocked_domains)
// P2: Auto-extract (search + fetch + AI extraction)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services/core/configService';
import { createLogger } from '../../services/infra/logger';
import { CLOUD_ENDPOINTS, SEARCH_API_ENDPOINTS } from '../../../shared/constants';
import { smartHtmlToText, smartTruncate, buildExtractionPrompt } from './htmlUtils';
import { fetchDocument } from './fetchDocument';

const logger = createLogger('WebSearch');

// ============================================================================
// Circuit Breaker for Rate-Limited Sources
// ============================================================================

/** source name -> cooldown expiry timestamp (ms) */
const circuitBreaker: Record<string, number> = {};
const CIRCUIT_BREAKER_COOLDOWN = 10 * 60 * 1000; // 10 minutes

/**
 * Check if a source is currently circuit-broken.
 * Returns remaining cooldown in ms, or 0 if source is available.
 */
function getCircuitBreakerRemaining(source: string): number {
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
 * Trip the circuit breaker for a source after receiving 429.
 */
function tripCircuitBreaker(source: string): void {
  circuitBreaker[source] = Date.now() + CIRCUIT_BREAKER_COOLDOWN;
  logger.warn('Circuit breaker tripped for source', {
    source,
    cooldownMs: CIRCUIT_BREAKER_COOLDOWN,
    resumeAt: new Date(circuitBreaker[source]).toISOString(),
  });
}

const CLOUD_SEARCH_URL = `${CLOUD_ENDPOINTS.tools}?action=search`;
const BRAVE_SEARCH_URL = SEARCH_API_ENDPOINTS.brave;
const EXA_SEARCH_URL = SEARCH_API_ENDPOINTS.exa;
const PERPLEXITY_API_URL = SEARCH_API_ENDPOINTS.perplexity;
const TAVILY_SEARCH_URL = SEARCH_API_ENDPOINTS.tavily;

// Domains to skip when auto-extracting (search engines themselves)
const SEARCH_ENGINE_DOMAINS = [
  'google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com',
  'baidu.com', 'yandex.com', 'brave.com',
];

// ============================================================================
// Types
// ============================================================================

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  description?: string;
  age?: string;
  source?: string;  // 标记数据来源
}

interface DomainFilter {
  allowed?: string[];
  blocked?: string[];
}

interface CloudSearchResponse {
  success: boolean;
  query: string;
  results?: SearchResult[];
  answer?: string;
  citations?: string[];
  source: 'perplexity' | 'brave';
  error?: string;
}

interface BraveSearchResponse {
  web?: {
    results: SearchResult[];
  };
}

interface ExaSearchResponse {
  results: Array<{
    title: string;
    url: string;
    text?: string;
    highlights?: string[];
    publishedDate?: string;
  }>;
}

interface PerplexityResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
}

interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
    published_date?: string;
  }>;
}

interface SearchSourceResult {
  source: string;
  success: boolean;
  results?: SearchResult[];
  answer?: string;
  citations?: string[];
  error?: string;
}

interface SourceRoutingResult {
  sources: string[];
  reason: string;
}

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


// ============================================================================
// Intelligent Source Routing
// ============================================================================

/**
 * Analyze query characteristics and route to best-fit search sources.
 * Each source has unique strengths — route to 2-3 instead of all 4 every time.
 *
 * Source strengths:
 * - perplexity: AI summary, best for Chinese queries, general knowledge
 * - exa: Semantic search, excels at technical/academic content
 * - brave: Real-time news, Twitter/social, broad web coverage
 * - tavily: Structured extraction, good AI answers, reliable fallback
 */
function routeSources(
  query: string,
  options: { mode?: 'quick' | 'research'; requestedSources?: string[] }
): SourceRoutingResult {
  // If user explicitly requested sources, respect that
  if (options.requestedSources?.length) {
    return { sources: options.requestedSources, reason: 'user-specified' };
  }

  const isChinese = /[\u4e00-\u9fff]{2,}/.test(query);
  const isTwitter = /twitter|x\.com|@\w+|\u63a8\u7279|tweet/i.test(query);
  const isAcademic = /paper|\u8bba\u6587|\u7814\u7a76|\u5b66\u672f|arxiv|scholar/i.test(query);
  const isNews = /\u65b0\u95fb|\u6700\u65b0|today|breaking|\u521a\u521a|\u70ed\u70b9|trending/i.test(query);
  const isTechnical = /api|sdk|framework|\u5e93|\u6587\u6863|documentation|github/i.test(query);
  const isResearchMode = options.mode === 'research';

  const selected: string[] = [];

  if (isChinese) {
    selected.push('perplexity');  // Best Chinese AI summary
    selected.push('tavily');      // Good structured extraction
    if (isResearchMode) selected.push('exa');  // Extra coverage (brave skipped: Free plan rate_limit=1)
  } else if (isTwitter) {
    selected.push('brave');       // Best for social/Twitter content
    selected.push('perplexity');  // AI summary context
  } else if (isTechnical) {
    selected.push('exa');         // Semantic search excels at technical content
    selected.push('perplexity');  // AI summary for docs
    if (isResearchMode) selected.push('tavily');
  } else if (isNews) {
    selected.push('brave');       // Best for real-time/news
    selected.push('perplexity');  // AI summary
  } else if (isAcademic) {
    selected.push('exa');         // Semantic search for papers
    selected.push('tavily');      // Structured extraction
    if (isResearchMode) selected.push('perplexity');
  } else {
    // Default: 2 sources for quick, 3 for research
    // Brave excluded from research mode: Free plan rate_limit=1 causes 429 under parallel load
    selected.push('perplexity');
    selected.push('tavily');
    if (isResearchMode) {
      selected.push('exa');
    }
  }

  return {
    sources: selected,
    reason: [
      isChinese && 'chinese',
      isTwitter && 'twitter',
      isAcademic && 'academic',
      isNews && 'news',
      isTechnical && 'technical',
      isResearchMode && 'research-mode',
    ].filter(Boolean).join('+') || 'default',
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web and return results with titles, URLs, and snippets.',
  dynamicDescription: () => {
    const now = new Date();
    const currentDate = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    const currentYear = now.getFullYear();
    return `Search the web and return results with titles, URLs, and snippets.

Provides up-to-date information beyond the model's knowledge cutoff. Use when you need current data, recent events, or documentation updates.

IMPORTANT: 当前日期为 ${currentDate}。搜索时务必使用正确的年份 ${currentYear}，不要搜索过时的年份。

CRITICAL: After answering with search results, you MUST include a "Sources:" section listing relevant URLs as markdown hyperlinks.

Use for: finding documentation, researching APIs, looking up error messages, discovering libraries, current events.
For reading a specific URL you already have, use web_fetch instead.
For searching local code, use grep or glob.

Features:
- Intelligent source routing: automatically picks 2-3 best-fit sources based on query characteristics
- mode: "quick" (2 sources, fast) or "research" (3-4 sources, thorough)
- Parallel search across multiple sources (Perplexity, EXA, Brave, Tavily)
- Domain filtering with allowed_domains / blocked_domains
- auto_extract: search + fetch + AI extraction in one call
- recency: filter results by day/week/month
- output_format: "table" for compact markdown output`;
  },
  requiresPermission: true,
  permissionLevel: 'network',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      count: {
        type: 'number',
        description: 'Number of results to return per source (default: 5, max: 10)',
      },
      parallel: {
        type: 'boolean',
        description: 'Enable parallel search across all available sources (default: true)',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific sources to use: cloud, perplexity, exa, brave (default: all available)',
      },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include results from these domains (e.g., ["docs.python.org", "github.com"])',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude results from these domains (e.g., ["pinterest.com", "quora.com"])',
      },
      auto_extract: {
        type: 'boolean',
        description: 'After search, auto-fetch top results and extract content (default: false)',
      },
      extract_count: {
        type: 'number',
        description: 'Number of results to auto-extract (default: 3, max: 5)',
      },
      recency: {
        type: 'string',
        description: 'Time filter: "day" (past 24h), "week" (past 7 days), "month" (past 30 days). Only returns results published within this window.',
      },
      output_format: {
        type: 'string',
        description: 'Output format: "default" (detailed with snippets) or "table" (compact markdown table ready to copy-paste). Use "table" when you need to directly include results in a report.',
      },
      mode: {
        type: 'string',
        enum: ['quick', 'research'],
        description: 'Search mode: "quick" uses 2 best-fit sources for speed, "research" uses 3-4 sources for thoroughness. Default: "quick".',
      },
      save_to: {
        type: 'string',
        description: 'File path to automatically save results. The tool writes the file directly — no need to call write_file separately.',
      },
      language: {
        type: 'string',
        description: 'Output language for results. When set (e.g., "zh"), titles and snippets are translated at the tool level. Requires output_format="table".',
      },
    },
    required: ['query'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const query = params.query as string;
    const count = Math.min(Math.max((params.count as number) || 5, 1), 10);
    const parallel = (params.parallel as boolean) ?? true;
    const requestedSources = params.sources as string[] | undefined;
    const mode = (params.mode as 'quick' | 'research') || 'quick';
    const autoExtract = params.auto_extract !== undefined
      ? Boolean(params.auto_extract)
      : mode === 'research'; // research 模式默认开启
    const extractCount = Math.min(Math.max((params.extract_count as number) || (mode === 'research' ? 3 : 1), 1), 5);
    const recency = params.recency as string | undefined;
    const outputFormat = (params.output_format as string) || 'default';
    const language = params.language as string | undefined;

    // Build domain filter
    const domainFilter: DomainFilter | undefined =
      (params.allowed_domains || params.blocked_domains)
        ? {
            allowed: params.allowed_domains as string[] | undefined,
            blocked: params.blocked_domains as string[] | undefined,
          }
        : undefined;

    const configService = getConfigService();

    // Get all sources with configured API keys
    const allAvailable = getAvailableSources(configService);

    if (allAvailable.length === 0) {
      return {
        success: false,
        error: 'No search sources available. Please configure at least one API key (EXA, Perplexity, or Brave) in Settings > Service API Keys.',
      };
    }

    // Intelligent source routing: analyze query to pick best-fit sources
    const routing = routeSources(query, { mode, requestedSources });

    // Intersect: only use routed sources that are actually available
    const routedAvailable = allAvailable.filter(s => routing.sources.includes(s.name));

    // If routing filtered everything out, fallback to all available
    const availableSources = routedAvailable.length > 0 ? routedAvailable : allAvailable;

    logger.info('Search source routing', {
      query: query.substring(0, 50),
      routed: routing.sources,
      reason: routing.reason,
      available: allAvailable.map(s => s.name),
      final: availableSources.map(s => s.name),
    });

    let searchResult: ToolExecutionResult;

    if (parallel && availableSources.length > 1) {
      searchResult = await parallelSearch(query, count, availableSources, configService, domainFilter, recency);
    } else {
      searchResult = await serialSearch(query, count, availableSources, configService, domainFilter, recency);
    }

    // Deduplicate results (handles same article from different sites)
    if (searchResult.success) {
      deduplicateResults(searchResult);
    }

    // P2: Auto-extract content from top results
    if (autoExtract && searchResult.success) {
      if (context.modelCallback) {
        // Electron mode: AI extraction via modelCallback
        const extractedContent = await autoExtractFromResults(
          searchResult,
          query,
          extractCount,
          context.modelCallback,
        );
        if (extractedContent) {
          searchResult.output = (searchResult.output || '') + '\n\n' + extractedContent;
        }
      } else {
        // CLI mode fallback: fetch + smartTruncate (no AI, but real page content)
        const extractedContent = await autoExtractFallback(
          searchResult,
          extractCount,
        );
        if (extractedContent) {
          searchResult.output = (searchResult.output || '') + '\n\n' + extractedContent;
        }
      }
    }

    // Convert to table format if requested
    if (outputFormat === 'table' && searchResult.success) {
      searchResult.output = formatAsTable(searchResult);
    }

    // Translate results at tool level if language is specified
    if (language && searchResult.success && searchResult.output) {
      // Skip translation when query language already matches target language
      const queryText = (params.query as string) || '';
      const hasChinese = /[\u4e00-\u9fff]/.test(queryText);
      const isAllEnglish = /^[a-zA-Z0-9\s\-_.,;:!?'"()\[\]{}<>@#$%^&*+=|/\\~`]+$/.test(queryText);
      const skipTranslation =
        (language === 'zh' && hasChinese) ||
        (language === 'en' && isAllEnglish);

      if (skipTranslation) {
        logger.debug('Skipping translation - query language matches target', { language, query: queryText });
      }

      const resultData = searchResult.result as { results?: SearchResult[] } | undefined;
      const results = resultData?.results || [];
      if (!skipTranslation && results.length > 0) {
        try {
          // Use quick model (fast & free) for translation instead of main model
          const { quickTask, isQuickModelAvailable } = await import('../../model/quickModel');
          if (!isQuickModelAvailable() && !context.modelCallback) {
            logger.warn('No model available for translation, skipping');
          }
          // Batch translate: send all titles+snippets in one call
          const items = results.map((r, i) => `${i + 1}. ${r.title}\n${r.snippet || r.description || ''}`).join('\n---\n');
          const prompt = `Translate the following search result titles and descriptions to ${language === 'zh' ? 'Chinese (简体中文)' : language}. Keep the numbering. Only output the translations, one per item, separated by ---:\n\n${items}`;

          let translated: string | undefined;
          if (isQuickModelAvailable()) {
            const result = await quickTask(prompt);
            translated = result.success ? result.content : undefined;
            if (!result.success) {
              logger.warn('Quick model translation failed, falling back to modelCallback', { error: result.error });
              // Fallback to modelCallback if quick model fails
              if (context.modelCallback) {
                translated = await context.modelCallback(prompt);
              }
            }
          } else if (context.modelCallback) {
            // Fallback: use modelCallback if quick model not available
            translated = await context.modelCallback(prompt);
          }

          if (translated) {
            // Parse translated items and rebuild output
            const translatedItems = translated.split('---').map(s => s.trim()).filter(Boolean);
            const lines: string[] = [];
            results.forEach((item, i) => {
              const tItem = translatedItems[i] || '';
              // Extract translated title (first line) and description (rest)
              const tLines = tItem.split('\n').filter(Boolean);
              const tTitle = tLines[0]?.replace(/^\d+\.\s*/, '') || item.title;
              const tDesc = tLines.slice(1).join(' ') || item.snippet || item.description || '';
              const age = item.age ? ` (${item.age})` : '';
              lines.push(`### ${i + 1}. ${tTitle.substring(0, 100)}${age}`);
              if (tDesc) lines.push(tDesc.substring(0, 200));
              lines.push(item.url);
              lines.push('');
            });
            searchResult.output = lines.join('\n');
            logger.info(`Translated ${results.length} results to ${language}`);
          }
        } catch (err) {
          logger.warn(`Translation failed, keeping original language:`, err instanceof Error ? err.message : err);
        }
      }
    }

    // Save to file if requested (bypasses model — writes directly)
    const saveTo = params.save_to as string | undefined;
    if (saveTo && searchResult.success && searchResult.output) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const resolvedPath = saveTo.replace(/^~/, process.env.HOME || '');
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        // Add header with today's date and query
        const today = new Date().toISOString().slice(0, 10);
        const fileContent = `# 搜索结果 - ${today}\n\n查询: ${query}\n\n${searchResult.output}`;
        fs.writeFileSync(resolvedPath, fileContent, 'utf8');
        searchResult.output += `\n\n✅ Results saved to: ${resolvedPath}`;
        logger.info(`Search results saved to: ${resolvedPath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        searchResult.output += `\n\n⚠️ Failed to save: ${msg}`;
        logger.warn(`Failed to save results to ${saveTo}:`, msg);
      }
    }

    return searchResult;
  },
};

// ============================================================================
// Table Format Output
// ============================================================================

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
// Search Source Configuration
// ============================================================================

interface SearchSource {
  name: string;
  search: (query: string, count: number, configService: ReturnType<typeof getConfigService>, domainFilter?: DomainFilter, recency?: string) => Promise<SearchSourceResult>;
  isAvailable: (configService: ReturnType<typeof getConfigService>) => boolean;
  priority: number;
}

const SEARCH_SOURCES: SearchSource[] = [
  {
    name: 'cloud',
    priority: 1,
    isAvailable: () => !!(process.env.SUPABASE_URL && typeof window !== 'undefined'), // 仅 Electron 模式
    search: searchViaCloud,
  },
  {
    name: 'perplexity',
    priority: 2,
    isAvailable: (cs) => !!cs?.getServiceApiKey('perplexity'),
    search: searchViaPerplexity,
  },
  {
    name: 'exa',
    priority: 3,
    isAvailable: (cs) => !!cs?.getServiceApiKey('exa'),
    search: searchViaExa,
  },
  {
    name: 'tavily',
    priority: 4,
    isAvailable: (cs) => !!cs?.getServiceApiKey('tavily') || !!process.env.TAVILY_API_KEY,
    search: searchViaTavily,
  },
  {
    name: 'brave',
    priority: 5,
    isAvailable: (cs) => !!cs?.getServiceApiKey('brave') || !!process.env.BRAVE_API_KEY,
    search: searchViaBrave,
  },
];

function getAvailableSources(
  configService: ReturnType<typeof getConfigService>,
  requestedSources?: string[]
): SearchSource[] {
  let sources = SEARCH_SOURCES.filter(s => s.isAvailable(configService));

  // 如果指定了特定数据源，只使用这些
  if (requestedSources && requestedSources.length > 0) {
    sources = sources.filter(s => requestedSources.includes(s.name));
  }

  // 按优先级排序
  return sources.sort((a, b) => a.priority - b.priority);
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

// ============================================================================
// Parallel Search
// ============================================================================

async function parallelSearch(
  query: string,
  count: number,
  sources: SearchSource[],
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<ToolExecutionResult> {
  const startTime = Date.now();

  // Filter out circuit-broken sources before searching
  const activeSources: SearchSource[] = [];
  const skippedSources: string[] = [];
  for (const source of sources) {
    const remaining = getCircuitBreakerRemaining(source.name);
    if (remaining > 0) {
      logger.info('Circuit breaker active, skipping source', {
        source: source.name,
        cooldownRemaining: `${Math.ceil(remaining / 1000)}s`,
      });
      skippedSources.push(`${source.name}: circuit breaker (${Math.ceil(remaining / 1000)}s remaining)`);
    } else {
      activeSources.push(source);
    }
  }

  if (activeSources.length === 0) {
    return {
      success: false,
      error: `All search sources are circuit-broken:\n${skippedSources.join('\n')}`,
    };
  }

  // 并行调用所有数据源（使用 allSettled 实现错误隔离）
  const searchPromises = activeSources.map(source =>
    source.search(query, count, configService, domainFilter, recency)
      .catch(error => ({
        source: source.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } as SearchSourceResult))
  );

  const results = await Promise.allSettled(searchPromises);

  // 收集成功的结果
  const successResults: SearchSourceResult[] = [];
  const failedSources: string[] = [...skippedSources];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const sourceName = activeSources[i].name;

    if (result.status === 'fulfilled') {
      if (result.value.success) {
        successResults.push(result.value);
      } else {
        // Check for 429 and trip circuit breaker
        if (result.value.error?.includes('429')) {
          tripCircuitBreaker(sourceName);
        }
        failedSources.push(`${sourceName}: ${result.value.error}`);
        logger.warn(`Search source ${sourceName} failed:`, result.value.error);
      }
    } else {
      const reason = String(result.reason);
      if (reason.includes('429')) {
        tripCircuitBreaker(sourceName);
      }
      failedSources.push(`${sourceName}: ${result.reason}`);
      logger.warn(`Search source ${sourceName} rejected:`, result.reason);
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`Parallel search completed in ${duration}ms:`, {
    success: successResults.length,
    failed: failedSources.length,
  });

  if (successResults.length === 0) {
    return {
      success: false,
      error: `All search sources failed:\n${failedSources.join('\n')}`,
    };
  }

  // 合并结果
  return mergeSearchResults(query, successResults, failedSources, duration);
}

// ============================================================================
// Serial Search (Fallback)
// ============================================================================

async function serialSearch(
  query: string,
  count: number,
  sources: SearchSource[],
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<ToolExecutionResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  for (const source of sources) {
    // Check circuit breaker
    const remaining = getCircuitBreakerRemaining(source.name);
    if (remaining > 0) {
      logger.info('Circuit breaker active, skipping source', {
        source: source.name,
        cooldownRemaining: `${Math.ceil(remaining / 1000)}s`,
      });
      errors.push(`${source.name}: circuit breaker (${Math.ceil(remaining / 1000)}s remaining)`);
      continue;
    }

    try {
      const result = await source.search(query, count, configService, domainFilter, recency);
      if (result.success) {
        const duration = Date.now() - startTime;
        return formatSingleSourceResult(query, result, duration);
      }
      // Check for 429 and trip circuit breaker
      if (result.error?.includes('429')) {
        tripCircuitBreaker(source.name);
      }
      errors.push(`${source.name}: ${result.error}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('429')) {
        tripCircuitBreaker(source.name);
      }
      errors.push(`${source.name}: ${message}`);
      logger.warn(`Search source ${source.name} failed:`, message);
    }
  }

  return {
    success: false,
    error: `All search sources failed:\n${errors.join('\n')}`,
  };
}

// ============================================================================
// Result Formatting
// ============================================================================

export function mergeSearchResults(
  query: string,
  results: SearchSourceResult[],
  failedSources: string[],
  duration: number
): ToolExecutionResult {
  const outputParts: string[] = [];
  const allResults: SearchResult[] = [];
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();

  outputParts.push(`# Search results for: "${query}"`);
  outputParts.push(`Sources: ${results.map(r => r.source).join(', ')}`);
  outputParts.push('');

  // 处理每个数据源的结果
  for (const result of results) {
    // Perplexity 返回 AI 生成的答案
    if (result.answer) {
      outputParts.push(`## AI Summary (${result.source})`);
      outputParts.push(result.answer);
      if (result.citations && result.citations.length > 0) {
        outputParts.push('\nCitations:');
        result.citations.forEach((c, i) => outputParts.push(`${i + 1}. ${c}`));
      }
      outputParts.push('');
    }

    // 传统搜索结果
    if (result.results && result.results.length > 0) {
      outputParts.push(`## Results from ${result.source}`);
      for (const item of result.results) {
        // 去重（基于 URL + 标题前缀规范化）
        const normalizedTitle = normalizeTitleForDedup(item.title || '');
        if (!seenUrls.has(item.url) && !seenTitles.has(normalizedTitle)) {
          seenUrls.add(item.url);
          if (normalizedTitle) seenTitles.add(normalizedTitle);
          allResults.push({ ...item, source: result.source });
          const snippet = item.snippet || item.description || '';
          outputParts.push(`- **${item.title}**${item.age ? ` (${item.age})` : ''}`);
          outputParts.push(`  ${item.url}`);
          if (snippet) outputParts.push(`  ${snippet}`);
        }
      }
      outputParts.push('');
    }
  }

  // Log dedup statistics
  const totalResults = results.reduce((sum, r) => sum + (r.results?.length || 0), 0);
  const dedupedResults = allResults.length;
  logger.info('Search results dedup', { before: totalResults, after: dedupedResults, removed: totalResults - dedupedResults });

  // 如果有失败的数据源，添加提示
  if (failedSources.length > 0) {
    outputParts.push(`_Note: Some sources failed: ${failedSources.join('; ')}_`);
  }

  return {
    success: true,
    output: outputParts.join('\n'),
    result: {
      results: allResults,
      sources: results.map(r => r.source),
      duration,
    },
  };
}

function formatSingleSourceResult(
  query: string,
  result: SearchSourceResult,
  duration: number
): ToolExecutionResult {
  const outputParts: string[] = [];

  outputParts.push(`Search results for: "${query}" (via ${result.source})`);
  outputParts.push('');

  if (result.answer) {
    outputParts.push(result.answer);
    if (result.citations && result.citations.length > 0) {
      outputParts.push('\nSources:');
      result.citations.forEach((c, i) => outputParts.push(`${i + 1}. ${c}`));
    }
  } else if (result.results && result.results.length > 0) {
    result.results.forEach((item, index) => {
      const snippet = item.snippet || item.description || '';
      outputParts.push(`${index + 1}. ${item.title}${item.age ? ` (${item.age})` : ''}`);
      outputParts.push(`   ${item.url}`);
      if (snippet) outputParts.push(`   ${snippet}`);
      outputParts.push('');
    });
  } else {
    outputParts.push('No results found.');
  }

  return {
    success: true,
    output: outputParts.join('\n'),
    result: {
      results: result.results || [],
      source: result.source,
      duration,
    },
  };
}

// ============================================================================
// Auto-Extract (P2)
// ============================================================================

/**
 * After search completes, fetch top N result URLs and extract content via AI.
 * Uses shared fetchDocument() for caching, timeout, and retry.
 */
async function autoExtractFromResults(
  searchResult: ToolExecutionResult,
  query: string,
  extractCount: number,
  modelCallback: (prompt: string) => Promise<string>,
): Promise<string | null> {
  // Extract URLs from search results
  const resultData = searchResult.result as { results?: SearchResult[] } | undefined;
  const urls = (resultData?.results || [])
    .map(r => r.url)
    .filter(url => {
      try {
        const hostname = new URL(url).hostname;
        return !SEARCH_ENGINE_DOMAINS.some(d => hostname.endsWith(d));
      } catch {
        return false;
      }
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

      // AI extraction — max 3000 chars per URL
      const extractionPrompt = buildExtractionPrompt(query, text, 3000);
      const extracted = await modelCallback(extractionPrompt);

      if (extracted && extracted.trim().length > 50) {
        return { url: doc.finalUrl, content: extracted.trim() };
      }

      // Fallback: smart truncate
      return { url: doc.finalUrl, content: smartTruncate(text, 3000) };
    } catch (err) {
      failedCount++;
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
async function autoExtractFallback(
  searchResult: ToolExecutionResult,
  extractCount: number,
): Promise<string | null> {
  const resultData = searchResult.result as { results?: SearchResult[] } | undefined;
  const urls = (resultData?.results || [])
    .map(r => r.url)
    .filter(url => {
      try {
        const hostname = new URL(url).hostname;
        return !SEARCH_ENGINE_DOMAINS.some(d => hostname.endsWith(d));
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

// ============================================================================
// Search Implementations
// ============================================================================

/**
 * Search via cloud proxy (uses server-side API keys)
 */
async function searchViaCloud(
  query: string,
  maxResults: number,
  _configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  _recency?: string
): Promise<SearchSourceResult> {
  const body: Record<string, unknown> = { query, maxResults };

  // Cloud proxy supports domain filtering natively
  if (domainFilter?.allowed) {
    body.allowedDomains = domainFilter.allowed;
  }
  if (domainFilter?.blocked) {
    body.blockedDomains = domainFilter.blocked;
  }

  const response = await fetch(CLOUD_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return {
      source: 'cloud',
      success: false,
      error: `HTTP ${response.status}`,
    };
  }

  const data = await response.json() as CloudSearchResponse;

  if (!data.success) {
    return {
      source: 'cloud',
      success: false,
      error: data.error || 'Cloud search failed',
    };
  }

  if (data.source === 'perplexity' && data.answer) {
    return {
      source: 'cloud-perplexity',
      success: true,
      answer: data.answer,
      citations: data.citations,
    };
  }

  return {
    source: 'cloud-brave',
    success: true,
    results: (data.results || []).map(r => ({
      ...r,
      source: 'cloud-brave',
    })),
  };
}

/**
 * Search via Perplexity API (AI-enhanced search)
 */
async function searchViaPerplexity(
  query: string,
  _maxResults: number,
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  _recency?: string
): Promise<SearchSourceResult> {
  const apiKey = configService?.getServiceApiKey('perplexity');
  if (!apiKey) {
    return { source: 'perplexity', success: false, error: 'API key not configured' };
  }

  // Perplexity: append domain constraints to the user message
  let messageContent = query;
  if (domainFilter) {
    const suffix = buildDomainQuerySuffix(domainFilter);
    if (suffix) messageContent += suffix;
  }

  const response = await fetch(PERPLEXITY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: messageContent }],
      max_tokens: 1024,
      return_citations: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      source: 'perplexity',
      success: false,
      error: `HTTP ${response.status}: ${errorText}`,
    };
  }

  const data = await response.json() as PerplexityResponse;
  const answer = data.choices?.[0]?.message?.content;

  if (!answer) {
    return { source: 'perplexity', success: false, error: 'Empty response' };
  }

  return {
    source: 'perplexity',
    success: true,
    answer,
    citations: data.citations || [],
  };
}

/**
 * Search via EXA API (semantic search)
 */
async function searchViaExa(
  query: string,
  maxResults: number,
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<SearchSourceResult> {
  const apiKey = configService?.getServiceApiKey('exa');
  if (!apiKey) {
    return { source: 'exa', success: false, error: 'API key not configured' };
  }

  const body: Record<string, unknown> = {
    query,
    numResults: maxResults,
    type: 'auto',
    useAutoprompt: true,
    contents: {
      text: { maxCharacters: 500 },
      highlights: true,
    },
  };

  // EXA: startPublishedDate for recency filtering
  if (recency) {
    const daysMap: Record<string, number> = { day: 1, week: 7, month: 30 };
    const days = daysMap[recency];
    if (days) {
      const d = new Date();
      d.setDate(d.getDate() - days);
      body.startPublishedDate = d.toISOString().slice(0, 10);
    }
  }

  // EXA supports native domain filtering
  if (domainFilter?.allowed && domainFilter.allowed.length > 0) {
    body.includeDomains = domainFilter.allowed;
  }
  if (domainFilter?.blocked && domainFilter.blocked.length > 0) {
    body.excludeDomains = domainFilter.blocked;
  }

  const response = await fetch(EXA_SEARCH_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      source: 'exa',
      success: false,
      error: `HTTP ${response.status}: ${errorText}`,
    };
  }

  const data = await response.json() as ExaSearchResponse;

  if (!data.results || data.results.length === 0) {
    return { source: 'exa', success: true, results: [] };
  }

  return {
    source: 'exa',
    success: true,
    results: data.results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.text || r.highlights?.[0] || '',
      age: r.publishedDate ? formatAge(r.publishedDate) : undefined,
      source: 'exa',
    })),
  };
}

/**
 * Search via Brave Search API
 */
async function searchViaBrave(
  query: string,
  maxResults: number,
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<SearchSourceResult> {
  const apiKey = configService?.getServiceApiKey('brave') || process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return { source: 'brave', success: false, error: 'API key not configured' };
  }

  // Brave: append site:/−site: operators to query
  let filteredQuery = query;
  if (domainFilter) {
    filteredQuery += buildDomainQuerySuffix(domainFilter);
  }

  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set('q', filteredQuery);
  url.searchParams.set('count', maxResults.toString());

  // Brave freshness: pd (past day), pw (past week), pm (past month)
  if (recency) {
    const freshnessMap: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm' };
    if (freshnessMap[recency]) url.searchParams.set('freshness', freshnessMap[recency]);
  }

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      source: 'brave',
      success: false,
      error: `HTTP ${response.status}: ${errorText}`,
    };
  }

  const data = await response.json() as BraveSearchResponse;
  const results = data.web?.results || [];

  return {
    source: 'brave',
    success: true,
    results: results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      age: r.age,
      source: 'brave',
    })),
  };
}

/**
 * Search via Tavily API (AI-powered search with answer + results)
 */
async function searchViaTavily(
  query: string,
  maxResults: number,
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<SearchSourceResult> {
  const apiKey = configService?.getServiceApiKey('tavily') || process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { source: 'tavily', success: false, error: 'API key not configured' };
  }

  const body: Record<string, unknown> = {
    query,
    max_results: maxResults,
    include_answer: 'basic',
    search_depth: 'basic',
  };

  // Tavily: days parameter for recency
  if (recency) {
    const daysMap: Record<string, number> = { day: 1, week: 7, month: 30 };
    if (daysMap[recency]) body.days = daysMap[recency];
  }

  // Tavily supports native domain filtering
  if (domainFilter?.allowed && domainFilter.allowed.length > 0) {
    body.include_domains = domainFilter.allowed;
  }
  if (domainFilter?.blocked && domainFilter.blocked.length > 0) {
    body.exclude_domains = domainFilter.blocked;
  }

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      source: 'tavily',
      success: false,
      error: `HTTP ${response.status}: ${errorText}`,
    };
  }

  const data = await response.json() as TavilySearchResponse;

  if (data.answer) {
    return {
      source: 'tavily',
      success: true,
      answer: data.answer,
      results: (data.results || []).map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        age: r.published_date ? formatAge(r.published_date) : undefined,
        source: 'tavily',
      })),
    };
  }

  return {
    source: 'tavily',
    success: true,
    results: (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      age: r.published_date ? formatAge(r.published_date) : undefined,
      source: 'tavily',
    })),
  };
}

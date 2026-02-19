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

const logger = createLogger('WebSearch');

const CLOUD_SEARCH_URL = `${CLOUD_ENDPOINTS.tools}?action=search`;
const BRAVE_SEARCH_URL = SEARCH_API_ENDPOINTS.brave;
const EXA_SEARCH_URL = SEARCH_API_ENDPOINTS.exa;
const PERPLEXITY_API_URL = SEARCH_API_ENDPOINTS.perplexity;

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

interface SearchSourceResult {
  source: string;
  success: boolean;
  results?: SearchResult[];
  answer?: string;
  citations?: string[];
  error?: string;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const webSearchTool: Tool = {
  name: 'web_search',
  description: `Search the web and return multiple results with titles, URLs, and snippets.

Use for: finding documentation, researching APIs, looking up error messages, discovering libraries.

For reading a specific URL you already have, use web_fetch instead.
For searching local code, use grep or glob.`,
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
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
    const autoExtract = (params.auto_extract as boolean) ?? false;
    const extractCount = Math.min(Math.max((params.extract_count as number) || 3, 1), 5);

    // Build domain filter
    const domainFilter: DomainFilter | undefined =
      (params.allowed_domains || params.blocked_domains)
        ? {
            allowed: params.allowed_domains as string[] | undefined,
            blocked: params.blocked_domains as string[] | undefined,
          }
        : undefined;

    const configService = getConfigService();

    // 确定可用的搜索源
    const availableSources = getAvailableSources(configService, requestedSources);

    if (availableSources.length === 0) {
      return {
        success: false,
        error: 'No search sources available. Please configure at least one API key (EXA, Perplexity, or Brave) in Settings > Service API Keys.',
      };
    }

    logger.info(`Searching with ${availableSources.length} sources:`, availableSources.map(s => s.name));

    let searchResult: ToolExecutionResult;

    if (parallel && availableSources.length > 1) {
      searchResult = await parallelSearch(query, count, availableSources, configService, domainFilter);
    } else {
      searchResult = await serialSearch(query, count, availableSources, configService, domainFilter);
    }

    // P2: Auto-extract content from top results
    if (autoExtract && searchResult.success && context.modelCallback) {
      const extractedContent = await autoExtractFromResults(
        searchResult,
        query,
        extractCount,
        context.modelCallback,
      );
      if (extractedContent) {
        searchResult.output = (searchResult.output || '') + '\n\n' + extractedContent;
      }
    }

    return searchResult;
  },
};

// ============================================================================
// Search Source Configuration
// ============================================================================

interface SearchSource {
  name: string;
  search: (query: string, count: number, configService: ReturnType<typeof getConfigService>, domainFilter?: DomainFilter) => Promise<SearchSourceResult>;
  isAvailable: (configService: ReturnType<typeof getConfigService>) => boolean;
  priority: number;
}

const SEARCH_SOURCES: SearchSource[] = [
  {
    name: 'cloud',
    priority: 1,
    isAvailable: () => true, // 云端总是尝试
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
    name: 'brave',
    priority: 4,
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
function buildDomainQuerySuffix(domainFilter?: DomainFilter): string {
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
  domainFilter?: DomainFilter
): Promise<ToolExecutionResult> {
  const startTime = Date.now();

  // 并行调用所有数据源（使用 allSettled 实现错误隔离）
  const searchPromises = sources.map(source =>
    source.search(query, count, configService, domainFilter)
      .catch(error => ({
        source: source.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } as SearchSourceResult))
  );

  const results = await Promise.allSettled(searchPromises);

  // 收集成功的结果
  const successResults: SearchSourceResult[] = [];
  const failedSources: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const sourceName = sources[i].name;

    if (result.status === 'fulfilled') {
      if (result.value.success) {
        successResults.push(result.value);
      } else {
        failedSources.push(`${sourceName}: ${result.value.error}`);
        logger.warn(`Search source ${sourceName} failed:`, result.value.error);
      }
    } else {
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
  domainFilter?: DomainFilter
): Promise<ToolExecutionResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  for (const source of sources) {
    try {
      const result = await source.search(query, count, configService, domainFilter);
      if (result.success) {
        const duration = Date.now() - startTime;
        return formatSingleSourceResult(query, result, duration);
      }
      errors.push(`${source.name}: ${result.error}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
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

function mergeSearchResults(
  query: string,
  results: SearchSourceResult[],
  failedSources: string[],
  duration: number
): ToolExecutionResult {
  const outputParts: string[] = [];
  const allResults: SearchResult[] = [];
  const seenUrls = new Set<string>();

  outputParts.push(`# Search results for: "${query}"`);
  outputParts.push(`Sources: ${results.map(r => r.source).join(', ')} | Duration: ${duration}ms`);
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
        // 去重（基于 URL）
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          allResults.push({ ...item, source: result.source });
          const snippet = item.snippet || item.description || '';
          outputParts.push(`- **${item.title}**`);
          outputParts.push(`  ${item.url}`);
          if (snippet) outputParts.push(`  ${snippet}`);
        }
      }
      outputParts.push('');
    }
  }

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
      outputParts.push(`${index + 1}. ${item.title}`);
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

  // Parallel fetch + extract with 10s timeout per URL
  const extractPromises = urls.map(async (url): Promise<{ url: string; content: string } | null> => {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CodeAgent/1.0)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return null;

      const html = await response.text();
      const text = smartHtmlToText(html);
      if (text.length < 50) return null;

      // AI extraction — max 3000 chars per URL
      const extractionPrompt = buildExtractionPrompt(query, text, 3000);
      const extracted = await modelCallback(extractionPrompt);

      if (extracted && extracted.trim().length > 50) {
        return { url, content: extracted.trim() };
      }

      // Fallback: smart truncate
      return { url, content: smartTruncate(text, 3000) };
    } catch {
      // Skip failed URLs silently
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

  if (extractedParts.length === 0) return null;

  return '---\n# Auto-Extracted Content\n\n' + extractedParts.join('\n');
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
  domainFilter?: DomainFilter
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
  domainFilter?: DomainFilter
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
  domainFilter?: DomainFilter
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
  domainFilter?: DomainFilter
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

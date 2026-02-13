// ============================================================================
// Web Search Tool - Multi-source parallel web search
// Supports: Cloud Proxy, Perplexity, EXA, Brave Search
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services/core/configService';
import { createLogger } from '../../services/infra/logger';
import { CLOUD_ENDPOINTS, SEARCH_API_ENDPOINTS } from '../../../shared/constants';

const logger = createLogger('WebSearch');

const CLOUD_SEARCH_URL = `${CLOUD_ENDPOINTS.tools}?action=search`;
const BRAVE_SEARCH_URL = SEARCH_API_ENDPOINTS.brave;
const EXA_SEARCH_URL = SEARCH_API_ENDPOINTS.exa;
const PERPLEXITY_API_URL = SEARCH_API_ENDPOINTS.perplexity;

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
    },
    required: ['query'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const query = params.query as string;
    const count = Math.min(Math.max((params.count as number) || 5, 1), 10);
    const parallel = (params.parallel as boolean) ?? true;
    const requestedSources = params.sources as string[] | undefined;

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

    if (parallel && availableSources.length > 1) {
      // 并行搜索所有可用数据源
      return parallelSearch(query, count, availableSources, configService);
    } else {
      // 串行搜索（优先级：cloud > perplexity > exa > brave）
      return serialSearch(query, count, availableSources, configService);
    }
  },
};

// ============================================================================
// Search Source Configuration
// ============================================================================

interface SearchSource {
  name: string;
  search: (query: string, count: number, configService: ReturnType<typeof getConfigService>) => Promise<SearchSourceResult>;
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
// Parallel Search
// ============================================================================

async function parallelSearch(
  query: string,
  count: number,
  sources: SearchSource[],
  configService: ReturnType<typeof getConfigService>
): Promise<ToolExecutionResult> {
  const startTime = Date.now();

  // 并行调用所有数据源（使用 allSettled 实现错误隔离）
  const searchPromises = sources.map(source =>
    source.search(query, count, configService)
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
  configService: ReturnType<typeof getConfigService>
): Promise<ToolExecutionResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  for (const source of sources) {
    try {
      const result = await source.search(query, count, configService);
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
// Search Implementations
// ============================================================================

/**
 * Search via cloud proxy (uses server-side API keys)
 */
async function searchViaCloud(
  query: string,
  maxResults: number,
  _configService: ReturnType<typeof getConfigService>
): Promise<SearchSourceResult> {
  const response = await fetch(CLOUD_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, maxResults }),
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
  configService: ReturnType<typeof getConfigService>
): Promise<SearchSourceResult> {
  const apiKey = configService?.getServiceApiKey('perplexity');
  if (!apiKey) {
    return { source: 'perplexity', success: false, error: 'API key not configured' };
  }

  const response = await fetch(PERPLEXITY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: query }],
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
  configService: ReturnType<typeof getConfigService>
): Promise<SearchSourceResult> {
  const apiKey = configService?.getServiceApiKey('exa');
  if (!apiKey) {
    return { source: 'exa', success: false, error: 'API key not configured' };
  }

  const response = await fetch(EXA_SEARCH_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      type: 'auto',
      useAutoprompt: true,
      contents: {
        text: { maxCharacters: 500 },
        highlights: true,
      },
    }),
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
  configService: ReturnType<typeof getConfigService>
): Promise<SearchSourceResult> {
  const apiKey = configService?.getServiceApiKey('brave') || process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return { source: 'brave', success: false, error: 'API key not configured' };
  }

  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set('q', query);
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

// ============================================================================
// Search Strategy Implementations
// Cloud, OpenAI, Perplexity, EXA, Brave, Tavily
// ============================================================================

import type { getConfigService } from '../../../services/core/configService';
import type {
  DomainFilter,
  SearchSourceResult,
  SourceRoutingResult,
  SearchSource,
  CloudSearchResponse,
  BraveSearchResponse,
  ExaSearchResponse,
  OpenAIResponsesResponse,
  PerplexityResponse,
  TavilySearchResponse,
} from './searchTypes';
import {
  CLOUD_SEARCH_URL,
  BRAVE_SEARCH_URL,
  EXA_SEARCH_URL,
  OPENAI_RESPONSES_URL,
  PERPLEXITY_API_URL,
  TAVILY_SEARCH_URL,
  buildDomainQuerySuffix,
  formatAge,
} from './searchUtils';
import { OPENAI_WEB_SEARCH_DEFAULT_MODEL } from '../../../../shared/constants';
import {
  getProviderHealth,
  searchWithProviderKeyRotation,
} from './providerCapabilityMatrix';
import { isFirecrawlDefaultEnabled, isFirecrawlHealthy, searchWithFirecrawl } from '../firecrawlClient';

// ============================================================================
// Intelligent Source Routing
// ============================================================================

/**
 * Analyze query characteristics and route to best-fit search sources.
 * Each source has unique strengths — route to 2-3 instead of all 4 every time.
 *
 * Source strengths:
 * - firecrawl: default web data layer, keyless search/scrape, good page extraction
 * - perplexity: AI summary, best for Chinese queries, general knowledge
 * - openai: model-native web_search tool, good zero-extra-vendor fallback
 * - exa: Semantic search, excels at technical/academic content
 * - brave: Real-time news, Twitter/social, broad web coverage
 * - tavily: Structured extraction, good AI answers, reliable fallback
 */
export function routeSources(
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

  const selected: string[] = ['firecrawl'];

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

  const dedupedSelected = Array.from(new Set(selected));
  return {
    sources: dedupedSelected,
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
// Search Source Configuration
// ============================================================================

export const SEARCH_SOURCES: SearchSource[] = [
  {
    name: 'firecrawl',
    priority: 1,
    isAvailable: () => isFirecrawlDefaultEnabled() && isFirecrawlHealthy(),
    search: searchViaFirecrawl,
  },
  {
    name: 'cloud',
    priority: 2,
    isAvailable: () => !!(process.env.SUPABASE_URL && typeof window !== 'undefined'), // 仅 Electron 模式
    search: searchViaCloud,
  },
  {
    name: 'perplexity',
    priority: 3,
    isAvailable: (cs) => getProviderHealth('perplexity', cs).available,
    search: searchViaPerplexity,
  },
  {
    name: 'openai',
    priority: 4,
    isAvailable: (cs) => getProviderHealth('openai', cs).available,
    search: searchViaOpenAI,
  },
  {
    name: 'exa',
    priority: 5,
    isAvailable: (cs) => getProviderHealth('exa', cs).available,
    search: searchViaExa,
  },
  {
    name: 'tavily',
    priority: 6,
    isAvailable: (cs) => getProviderHealth('tavily', cs).available,
    search: searchViaTavily,
  },
  {
    name: 'brave',
    priority: 7,
    isAvailable: (cs) => !!cs?.getServiceApiKey('brave') || !!process.env.BRAVE_API_KEY,
    search: searchViaBrave,
  },
];

/** 用户搜索源偏好（ADR-026），取自 AppSettings.search。 */
export interface SearchSourcePrefs {
  /** 用户禁用的搜索源 id */
  disabledSources?: string[];
  /** 源优先级覆盖（id 顺序，越靠前越优先） */
  sourceOrder?: string[];
}

export function getAvailableSources(
  configService: ReturnType<typeof getConfigService>,
  requestedSources?: string[],
  prefs?: SearchSourcePrefs
): SearchSource[] {
  let sources = SEARCH_SOURCES.filter(s => s.isAvailable(configService));

  // 用户禁用的源直接剔除（ADR-026）
  const disabled = prefs?.disabledSources;
  if (disabled && disabled.length > 0) {
    sources = sources.filter(s => !disabled.includes(s.name));
  }

  // 如果指定了特定数据源，只使用这些
  if (requestedSources && requestedSources.length > 0) {
    sources = sources.filter(s => requestedSources.includes(s.name));
  }

  // 排序：用户自定义优先级在前（按 sourceOrder 顺序），未列出的随后按内置 priority
  const order = prefs?.sourceOrder;
  if (order && order.length > 0) {
    const rank = new Map(order.map((id, index) => [id, index]));
    return sources.sort((a, b) => {
      const ra = rank.has(a.name) ? (rank.get(a.name) as number) : Number.POSITIVE_INFINITY;
      const rb = rank.has(b.name) ? (rank.get(b.name) as number) : Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      return a.priority - b.priority;
    });
  }

  // 默认按内置优先级排序
  return sources.sort((a, b) => a.priority - b.priority);
}

/**
 * Premium 搜索源（需用户配置 key），区别于 firecrawl/cloud 这类默认基础设施源。
 * 仅这些源在"配置了但本次未命中"时值得提示用户可显式指定。
 */
const HINTABLE_PREMIUM_SOURCES: readonly string[] = ['perplexity', 'exa', 'brave', 'tavily'];

/**
 * P2 可发现性：当用户配置了 premium 搜索源、但本次查询的智能路由未命中它们时，
 * 生成一行软提示，告诉用户可通过 sources 参数针对性检索。
 * - 用户已显式指定 sources：返回 null（用户已掌控，不打扰）
 * - 无未命中的 premium 源：返回 null
 */
export function buildUnusedSourcesHint(
  availableSourceNames: string[],
  usedSourceNames: string[],
  requestedSources?: string[]
): string | null {
  if (requestedSources && requestedSources.length > 0) return null;
  const used = new Set(usedSourceNames);
  const unused = availableSourceNames.filter(
    name => HINTABLE_PREMIUM_SOURCES.includes(name) && !used.has(name)
  );
  if (unused.length === 0) return null;
  return `_提示: 已配置但本次未启用的搜索源: ${unused.join(', ')}。如需针对性检索可指定 sources: ${JSON.stringify([unused[0]])}_`;
}

// ============================================================================
// Search Implementations
// ============================================================================

async function searchViaFirecrawl(
  query: string,
  maxResults: number,
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<SearchSourceResult> {
  const result = await searchWithFirecrawl(query, maxResults, {
    configService,
    includeDomains: domainFilter?.allowed,
    excludeDomains: domainFilter?.blocked,
    recency,
  });

  if (!result.ok) {
    return { source: 'firecrawl', success: false, error: result.error };
  }

  return {
    source: result.credentialMode === 'authenticated' ? 'firecrawl' : 'firecrawl-keyless',
    success: true,
    results: result.results.map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      age: item.age,
      source: result.credentialMode === 'authenticated' ? 'firecrawl' : 'firecrawl-keyless',
    })),
  };
}

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
  return searchWithProviderKeyRotation('perplexity', configService, async (apiKey) => {
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
  });
}

function buildOpenAIWebSearchInput(
  query: string,
  recency?: string,
): string {
  const hints: string[] = [];
  if (recency) {
    const label: Record<string, string> = {
      day: 'the past 24 hours',
      week: 'the past 7 days',
      month: 'the past 30 days',
    };
    if (label[recency]) {
      hints.push(`Prefer results from ${label[recency]}.`);
    }
  }
  return hints.length > 0 ? `${query}\n\n${hints.join('\n')}` : query;
}

function normalizeOpenAIDomains(domains: string[] | undefined): string[] | undefined {
  const normalized = (domains ?? [])
    .map((domain) => domain.trim())
    .filter(Boolean)
    .map((domain) => domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function buildOpenAIWebSearchTool(domainFilter?: DomainFilter): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'web_search',
    search_context_size: 'low',
  };
  const allowedDomains = normalizeOpenAIDomains(domainFilter?.allowed);
  const blockedDomains = normalizeOpenAIDomains(domainFilter?.blocked);
  const filters: Record<string, string[]> = {};
  if (allowedDomains) filters.allowed_domains = allowedDomains;
  if (blockedDomains) filters.blocked_domains = blockedDomains;
  if (Object.keys(filters).length > 0) {
    tool.filters = filters;
  }
  return tool;
}

function resolveOpenAIResponsesUrl(configService: ReturnType<typeof getConfigService>): string {
  const configuredBaseUrl = configService?.getServiceApiBaseUrl?.('openai');
  if (!configuredBaseUrl) {
    return OPENAI_RESPONSES_URL;
  }
  const baseUrl = configuredBaseUrl.replace(/\/+$/, '');
  return baseUrl.endsWith('/responses') ? baseUrl : `${baseUrl}/responses`;
}

function extractOpenAITextAndCitations(data: OpenAIResponsesResponse): {
  text: string;
  citations: string[];
  results: Array<{ title: string; url: string; snippet: string; source: string }>;
} {
  const textParts: string[] = [];
  const citations: string[] = [];
  const results: Array<{ title: string; url: string; snippet: string; source: string }> = [];
  const seenUrls = new Set<string>();

  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    textParts.push(data.output_text.trim());
  }

  for (const item of data.output ?? []) {
    for (const source of item.action?.sources ?? []) {
      const url = typeof source.url === 'string' ? source.url : '';
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const title = typeof source.title === 'string' && source.title.trim()
        ? source.title.trim()
        : url;
      citations.push(url);
      results.push({ title, url, snippet: '', source: 'openai' });
    }

    for (const content of item.content ?? []) {
      if (typeof content.text === 'string' && content.text.trim() && textParts.length === 0) {
        textParts.push(content.text.trim());
      }
      for (const annotation of content.annotations ?? []) {
        const citation = annotation.url_citation;
        const url = typeof annotation.url === 'string'
          ? annotation.url
          : typeof citation?.url === 'string'
            ? citation.url
            : '';
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        const title = typeof annotation.title === 'string' && annotation.title.trim()
          ? annotation.title.trim()
          : typeof citation?.title === 'string' && citation.title.trim()
            ? citation.title.trim()
          : url;
        citations.push(url);
        results.push({
          title,
          url,
          snippet: typeof content.text === 'string' ? content.text.slice(0, 500) : '',
          source: 'openai',
        });
      }
    }
  }

  return {
    text: textParts.join('\n\n'),
    citations,
    results,
  };
}

/**
 * Search via OpenAI Responses API with the built-in web_search tool.
 */
async function searchViaOpenAI(
  query: string,
  _maxResults: number,
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<SearchSourceResult> {
  return searchWithProviderKeyRotation('openai', configService, async (apiKey) => {
    const body = {
      model: process.env.OPENAI_SEARCH_MODEL || OPENAI_WEB_SEARCH_DEFAULT_MODEL,
      input: buildOpenAIWebSearchInput(query, recency),
      tools: [buildOpenAIWebSearchTool(domainFilter)],
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
    };

    const response = await fetch(resolveOpenAIResponsesUrl(configService), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        source: 'openai',
        success: false,
        error: `HTTP ${response.status}: ${errorText}`,
      };
    }

    const data = await response.json() as OpenAIResponsesResponse;
    const extracted = extractOpenAITextAndCitations(data);
    if (!extracted.text) {
      return { source: 'openai', success: false, error: 'Empty response' };
    }

    return {
      source: 'openai',
      success: true,
      answer: extracted.text,
      citations: extracted.citations,
      results: extracted.results,
    };
  });
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
  return searchWithProviderKeyRotation('exa', configService, async (apiKey) => {
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
  });
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

// ============================================================================
// Tavily search implementation
// ============================================================================

async function callTavily(
  apiKey: string,
  query: string,
  maxResults: number,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<{ ok: true; data: TavilySearchResponse } | { ok: false; error: string }> {
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
    return { ok: false, error: `HTTP ${response.status}: ${errorText}` };
  }

  return { ok: true, data: await response.json() as TavilySearchResponse };
}

/**
 * Search via Tavily API (AI-powered search with answer + results).
 * Rotates across the key pool: on a quota/auth failure the current key is marked
 * exhausted and the next key is tried automatically.
 */
async function searchViaTavily(
  query: string,
  maxResults: number,
  configService: ReturnType<typeof getConfigService>,
  domainFilter?: DomainFilter,
  recency?: string
): Promise<SearchSourceResult> {
  return searchWithProviderKeyRotation('tavily', configService, async (apiKey) => {
    const res = await callTavily(apiKey, query, maxResults, domainFilter, recency);

    if (!res.ok) {
      return { source: 'tavily', success: false, error: res.error };
    }

    const data = res.data;
    const results = (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      age: r.published_date ? formatAge(r.published_date) : undefined,
      source: 'tavily',
    }));
    return data.answer
      ? { source: 'tavily', success: true, answer: data.answer, results }
      : { source: 'tavily', success: true, results };
  });
}

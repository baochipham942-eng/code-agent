// ============================================================================
// Search Strategy Implementations
// Cloud, Perplexity, EXA, Brave, Tavily
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
  PerplexityResponse,
  TavilySearchResponse,
} from './searchTypes';
import {
  CLOUD_SEARCH_URL,
  BRAVE_SEARCH_URL,
  EXA_SEARCH_URL,
  PERPLEXITY_API_URL,
  TAVILY_SEARCH_URL,
  buildDomainQuerySuffix,
  formatAge,
} from './searchUtils';

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
// Search Source Configuration
// ============================================================================

export const SEARCH_SOURCES: SearchSource[] = [
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

export function getAvailableSources(
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

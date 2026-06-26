export type SearchIntent =
  | 'official_docs'
  | 'github_issue'
  | 'academic'
  | 'news'
  | 'misleading_seo'
  | 'general';

export interface PlannedSearchQuery {
  query: string;
  purpose: 'primary' | 'official' | 'github' | 'academic' | 'news';
}

export interface SearchPlan {
  intent: SearchIntent;
  queries: PlannedSearchQuery[];
  maxQueryRewrites: number;
  expectedSourceTypes: string[];
}

function classifySearchIntent(query: string): SearchIntent {
  if (/github|issue|pull request|\bpr\b|bug|repository|repo/i.test(query)) return 'github_issue';
  if (/paper|academic|arxiv|scholar|研究|论文/i.test(query)) return 'academic';
  if (/news|today|latest|breaking|trending|最新|新闻|热点/i.test(query)) return 'news';
  if (/api|sdk|docs?|documentation|release note|breaking change|官方|文档/i.test(query)) return 'official_docs';
  if (/best|top|review|compare|vs|how to fix|what is|什么是|对比/i.test(query)) return 'misleading_seo';
  return 'general';
}

function includesSiteOperator(query: string): boolean {
  return /\bsite:/i.test(query);
}

function dedupeQueries(queries: PlannedSearchQuery[]): PlannedSearchQuery[] {
  const seen = new Set<string>();
  const out: PlannedSearchQuery[] = [];
  for (const query of queries) {
    const key = query.query.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...query, query: query.query.trim() });
  }
  return out;
}

export function buildSearchPlan(
  query: string,
  options: { mode?: 'quick' | 'research'; requestedSources?: string[] } = {},
): SearchPlan {
  const intent = classifySearchIntent(query);
  const maxQueryRewrites = options.mode === 'research' ? 1 : 0;
  const maxQueries = maxQueryRewrites + 1;
  const queries: PlannedSearchQuery[] = [{ query, purpose: 'primary' }];
  const hasExplicitSourceOrSite = Boolean(options.requestedSources?.length) || includesSiteOperator(query);

  if (maxQueryRewrites > 0 && !hasExplicitSourceOrSite) {
    if (intent === 'official_docs') {
      queries.push({ query: `${query} official documentation`, purpose: 'official' });
    } else if (intent === 'github_issue') {
      queries.push({ query: `${query} site:github.com`, purpose: 'github' });
    } else if (intent === 'academic') {
      queries.push({ query: `${query} paper arxiv`, purpose: 'academic' });
    } else if (intent === 'news') {
      queries.push({ query: `${query} latest news`, purpose: 'news' });
    } else if (intent === 'misleading_seo') {
      queries.push({ query: `${query} official source`, purpose: 'official' });
    }
  }

  const expectedSourceTypes: Record<SearchIntent, string[]> = {
    official_docs: ['official', 'documentation', 'release_note'],
    github_issue: ['github', 'issue', 'pull_request'],
    academic: ['paper', 'academic', 'primary'],
    news: ['news', 'recent'],
    misleading_seo: ['official', 'primary', 'canonical'],
    general: ['general'],
  };

  return {
    intent,
    queries: dedupeQueries(queries).slice(0, maxQueries),
    maxQueryRewrites,
    expectedSourceTypes: expectedSourceTypes[intent],
  };
}

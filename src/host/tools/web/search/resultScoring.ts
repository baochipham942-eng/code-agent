import type { SearchResult } from './searchTypes';
import { SEARCH_ENGINE_DOMAINS, isDomainBlocked, PREFERRED_EXTRACT_DOMAINS } from './searchUtils';

const OFFICIAL_HOST_HINTS = [
  'docs.',
  'developer.',
  'developers.',
  'api.',
  'github.com',
  'gitlab.com',
  'npmjs.com',
  'pypi.org',
  'crates.io',
  'arxiv.org',
];

const SEO_HOST_HINTS = [
  'medium.com',
  'dev.to',
  'hashnode.dev',
  'towardsdatascience.com',
  'geeksforgeeks.org',
  'top10',
  'best-',
  'compare',
  'alternativeto.net',
];

const PROVIDER_RELIABILITY: Record<string, number> = {
  firecrawl: 9,
  'firecrawl-keyless': 8,
  exa: 8,
  brave: 7,
  tavily: 7,
  openai: 6,
  perplexity: 6,
  'cloud-brave': 6,
  'cloud-perplexity': 6,
};

function hostnameFor(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isPreferredEvidenceHost(hostname: string): boolean {
  return PREFERRED_EXTRACT_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

function hasOfficialHint(hostname: string): boolean {
  return OFFICIAL_HOST_HINTS.some(hint =>
    hint.includes('.')
      ? hostname === hint || hostname.endsWith(`.${hint}`) || hostname.includes(hint)
      : hostname.includes(hint)
  );
}

function hasSeoRisk(hostname: string, result: SearchResult): boolean {
  const haystack = `${hostname} ${result.title || ''} ${result.snippet || ''} ${result.description || ''}`.toLowerCase();
  return SEO_HOST_HINTS.some(hint => haystack.includes(hint));
}

function freshnessScore(age: string | undefined): number {
  if (!age) return 0;
  if (/just now|hour/i.test(age)) return 6;
  if (/1 day|2 days|3 days|4 days|5 days|6 days|7 days/i.test(age)) return 5;
  if (/day/i.test(age)) return 3;
  if (/month/i.test(age)) return 1;
  return 0;
}

function snippetScore(result: SearchResult): number {
  const text = result.snippet || result.description || '';
  if (text.length > 180) return 4;
  if (text.length > 80) return 3;
  if (text.length > 20) return 1;
  return 0;
}

export function scoreSearchResult(result: SearchResult): number {
  const hostname = hostnameFor(result.url);
  let score = 0;

  if (isPreferredEvidenceHost(hostname)) score += 14;
  if (hasOfficialHint(hostname)) score += 8;
  if (hostname && !SEARCH_ENGINE_DOMAINS.some(domain => hostname.endsWith(domain))) score += 2;
  if (hostname && !isDomainBlocked(result.url)) score += 3;
  score += freshnessScore(result.age);
  score += snippetScore(result);
  score += (PROVIDER_RELIABILITY[result.source || ''] ?? 4);
  if (hasSeoRisk(hostname, result)) score -= 8;

  return score;
}

export function rankSearchResults(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => {
    const scoreDelta = scoreSearchResult(b) - scoreSearchResult(a);
    if (scoreDelta !== 0) return scoreDelta;
    return (a.title || '').localeCompare(b.title || '');
  });
}

export function rankSearchResultData<T extends { result?: unknown }>(searchResult: T): T {
  const resultData = searchResult.result as { results?: SearchResult[] } | undefined;
  if (!resultData?.results || resultData.results.length === 0) return searchResult;
  resultData.results = rankSearchResults(resultData.results);
  return searchResult;
}

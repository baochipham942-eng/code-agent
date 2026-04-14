// ============================================================================
// Web Search Types
// ============================================================================

import type { getConfigService } from '../../../services/core/configService';

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  description?: string;
  age?: string;
  source?: string;
}

export interface DomainFilter {
  allowed?: string[];
  blocked?: string[];
}

export interface CloudSearchResponse {
  success: boolean;
  query: string;
  results?: SearchResult[];
  answer?: string;
  citations?: string[];
  source: 'perplexity' | 'brave';
  error?: string;
}

export interface BraveSearchResponse {
  web?: {
    results: SearchResult[];
  };
}

export interface ExaSearchResponse {
  results: Array<{
    title: string;
    url: string;
    text?: string;
    highlights?: string[];
    publishedDate?: string;
  }>;
}

export interface PerplexityResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
}

export interface TavilySearchResponse {
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

export interface SearchSourceResult {
  source: string;
  success: boolean;
  results?: SearchResult[];
  answer?: string;
  citations?: string[];
  error?: string;
}

export interface SourceRoutingResult {
  sources: string[];
  reason: string;
}

export interface SearchSource {
  name: string;
  search: (query: string, count: number, configService: ReturnType<typeof getConfigService>, domainFilter?: DomainFilter, recency?: string) => Promise<SearchSourceResult>;
  isAvailable: (configService: ReturnType<typeof getConfigService>) => boolean;
  priority: number;
}

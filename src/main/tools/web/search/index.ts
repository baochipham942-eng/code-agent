// ============================================================================
// Web Search Sub-modules
// ============================================================================

export type {
  SearchResult,
  DomainFilter,
  SearchSourceResult,
  SourceRoutingResult,
  SearchSource,
} from './searchTypes';

export {
  formatAge,
  formatAsTable,
  normalizeTitleForDedup,
  deduplicateResults,
  buildDomainQuerySuffix,
  getCircuitBreakerRemaining,
  tripCircuitBreaker,
  getSearchErrorCircuitBreakerCooldown,
  SEARCH_PROVIDER_SETUP_MESSAGE,
  SEARCH_FAILURE_GUIDANCE,
  SEARCH_ENGINE_DOMAINS,
} from './searchUtils';

export {
  routeSources,
  SEARCH_SOURCES,
  getAvailableSources,
  getTavilyKeys,
} from './searchStrategies';

export {
  parallelSearch,
  serialSearch,
  mergeSearchResults,
} from './searchOrchestrator';

export {
  autoExtractFromResults,
  autoExtractFallback,
} from './contentExtractor';

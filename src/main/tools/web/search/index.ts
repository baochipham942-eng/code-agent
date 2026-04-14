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
  SEARCH_ENGINE_DOMAINS,
} from './searchUtils';

export {
  routeSources,
  SEARCH_SOURCES,
  getAvailableSources,
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

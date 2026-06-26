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
  buildUnusedSourcesHint,
} from './searchStrategies';

export {
  SEARCH_PROVIDER_CAPABILITIES,
  getProviderCapabilityMatrix,
  getProviderHealth,
  getAvailableProviderKeys,
  getProviderKeys,
  getTavilyKeys,
  markProviderKeyCooldown,
  resetProviderHealthForTests,
  searchWithProviderKeyRotation,
} from './providerCapabilityMatrix';

export type {
  ProviderCapability,
  ProviderCapabilityStatus,
  ProviderHealth,
  PremiumSearchProviderId,
  SearchProviderId,
} from './providerCapabilityMatrix';

export {
  parallelSearch,
  serialSearch,
  mergeSearchResults,
} from './searchOrchestrator';

export {
  buildSearchPlan,
} from './searchPlanner';

export type {
  PlannedSearchQuery,
  SearchIntent,
  SearchPlan,
} from './searchPlanner';

export {
  rankSearchResultData,
  rankSearchResults,
  scoreSearchResult,
} from './resultScoring';

export {
  autoExtractFromResults,
  autoExtractFallback,
} from './contentExtractor';

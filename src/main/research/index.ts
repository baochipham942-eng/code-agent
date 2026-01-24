// ============================================================================
// Deep Research Module - 深度研究模式
// ============================================================================

// Types
export * from './types';

// Core components (original)
export { ResearchPlanner } from './researchPlanner';
export { ResearchExecutor, type ProgressCallback, type ResearchExecutorConfig } from './researchExecutor';
export { ReportGenerator } from './reportGenerator';

// Main controller (original)
export {
  DeepResearchMode,
  type DeepResearchModeConfig,
  type DeepResearchResult,
} from './deepResearchMode';

// Semantic research components (new)
export { IntentClassifier, type IntentClassifierConfig } from './intentClassifier';
export {
  DataSourceRouter,
  type DataSourceRouterConfig,
  type SourceAvailabilityChecker,
} from './dataSourceRouter';
export {
  ResultAggregator,
  defaultAggregator,
  type AggregatorConfig,
  type AggregatedResult,
  type AggregationStats,
} from './resultAggregator';
export {
  AdaptiveConfigGenerator,
  createAdaptiveConfigGenerator,
  getDepthPreset,
  isDeepResearchConfig,
} from './adaptiveConfig';
export {
  ProgressiveResearchLoop,
  createProgressiveLoop,
  type ProgressiveLoopConfig,
} from './progressiveLoop';

// Search fallback handler (new)
export {
  SearchFallbackHandler,
  createSearchFallbackHandler,
  classifyError,
  SearchErrorType,
  type SearchFallbackConfig,
  type SearchExecutor,
  type SearchExecutionResult,
  type SearchAttemptResult,
  type FallbackExecutionResult,
} from './searchFallback';

// Semantic research orchestrator (new)
export {
  SemanticResearchOrchestrator,
  createSemanticResearchOrchestrator,
  type SemanticResearchOrchestratorConfig,
  type SemanticResearchResult,
} from './semanticResearchOrchestrator';

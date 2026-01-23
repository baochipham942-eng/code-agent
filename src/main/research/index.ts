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
export { IntentClassifier } from './intentClassifier';
export {
  DataSourceRouter,
  type DataSourceRouterConfig,
  type SourceAvailabilityChecker,
} from './dataSourceRouter';
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

// Semantic research orchestrator (new)
export {
  SemanticResearchOrchestrator,
  createSemanticResearchOrchestrator,
  type SemanticResearchOrchestratorConfig,
  type SemanticResearchResult,
} from './semanticResearchOrchestrator';

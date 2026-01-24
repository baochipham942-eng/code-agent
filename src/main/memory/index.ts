// ============================================================================
// Memory Module - Gen5 Memory System Exports
// ============================================================================

// Vector Store
export {
  VectorStore,
  getVectorStore,
  initVectorStore,
  type VectorDocument,
  type VectorDocumentMetadata,
  type SearchResult,
  type SearchResultExport,
  type CloudSearchResult,
  type HybridSearchOptions,
  type VectorStoreConfig,
} from './vectorStore';

// Embedding Service
export {
  EmbeddingService,
  getEmbeddingService,
  initEmbeddingService,
  LocalEmbedding,
  DeepSeekEmbedding,
  OpenAIEmbedding,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from './embeddingService';

// Memory Service
export {
  MemoryService,
  getMemoryService,
  initMemoryService,
  type MemoryContext,
  type MemoryConfig,
  type SearchOptions,
  type EnhancedSearchResult,
} from './memoryService';

// Proactive Context
export {
  ProactiveContextService,
  getProactiveContextService,
  initProactiveContextService,
  type EntityType,
  type DetectedEntity,
  type ContextItem,
  type ProactiveContextResult,
  type ProactiveContextConfig,
} from './proactiveContext';

// Memory Trigger Service (Session Start Auto-trigger)
export {
  MemoryTriggerService,
  getMemoryTriggerService,
  initMemoryTriggerService,
  type SessionMemoryContext,
  type MemoryTriggerConfig,
} from './memoryTriggerService';

// Session Summarizer (Smart Forking Phase 2)
export {
  SessionSummarizer,
  getSessionSummarizer,
  initSessionSummarizer,
  type SessionSummary,
  type SummarizerConfig,
} from './sessionSummarizer';

// Fork Detector (Smart Forking Phase 2)
export {
  ForkDetector,
  getForkDetector,
  initForkDetector,
  type RelevantSession,
  type ForkDetectionResult,
  type ForkDetectorConfig,
} from './forkDetector';

// Context Injector (Smart Forking Phase 2)
export {
  ContextInjector,
  getContextInjector,
  initContextInjector,
  type InjectedContext,
  type InjectorConfig,
} from './contextInjector';

// ============================================================================
// Memory Module - Gen5 Memory System Exports
// ============================================================================

// Vector Store (Cloud)
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

// Local Vector Store (sqlite-vec)
export {
  LocalVectorStore,
  getLocalVectorStore,
  initLocalVectorStore,
  type LocalVectorDocument,
  type LocalVectorMetadata,
  type LocalSearchResult,
  type FTSSearchResult,
  type LocalVectorStoreConfig,
} from './localVectorStore';

// Hybrid Search (vector + FTS + RRF)
export {
  HybridSearchService,
  getHybridSearchService,
  createHybridSearchService,
  type HybridSearchResult,
  type HybridSearchOptions as HybridSearchServiceOptions,
  type SearchStats,
} from './hybridSearch';

// Embedding Service (with fallback chain)
export {
  EmbeddingService,
  getEmbeddingService,
  initEmbeddingService,
  LocalEmbedding,
  DeepSeekEmbedding,
  OpenAIEmbedding,
  GeminiEmbedding,
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

// Session Summarizer (Smart Forking Phase 2)
export {
  SessionSummarizer,
  getSessionSummarizer,
  initSessionSummarizer,
  type SessionSummary,
  type SummarizerConfig,
} from './sessionSummarizer';

// Context Injector (Smart Forking Phase 2)
export {
  ContextInjector,
  getContextInjector,
  initContextInjector,
  type InjectedContext,
  type InjectorConfig,
} from './contextInjector';

// Core Memory (Enhanced User Preferences - Week 3)
export {
  CoreMemoryService,
  getCoreMemoryService,
  initCoreMemoryService,
  type CoreMemory,
  type HumanProfile,
  type CodingStyle,
  type WorkflowPreferences,
  type AgentPersona,
  type LearnedPreferences,
} from './coreMemory';

// Continuous Learning Service
export {
  ContinuousLearningService,
  getContinuousLearningService,
  createContinuousLearningService,
  type LearningResult,
  type LearningConfig,
  type SkillRecommendation,
} from './continuousLearningService';

// Desktop Activity Understanding
export {
  DesktopActivityUnderstandingService,
  getDesktopActivityUnderstandingService,
  initDesktopActivityUnderstandingService,
  buildDesktopActivitySlices,
  summarizeDesktopActivitySlice,
  deriveTodoCandidatesFromSlice,
  type DesktopActivityUnderstandingConfig,
  type DesktopActivitySlice,
  type DesktopActivityDerivationRun,
} from './desktopActivityUnderstandingService';

// Workspace Activity Search
export {
  searchWorkspaceActivity,
  buildWorkspaceActivityContextBlock,
  formatWorkspaceActivitySearchItem,
  formatWorkspaceActivityTimestamp,
  normalizeWorkspaceSearchQuery,
  type WorkspaceActivitySource,
  type WorkspaceActivitySearchItem,
  type WorkspaceActivitySearchOptions,
  type WorkspaceActivitySearchResult,
} from './workspaceActivitySearchService';
export {
  WorkspaceArtifactIndexService,
  getWorkspaceArtifactIndexService,
  initWorkspaceArtifactIndexService,
  type WorkspaceArtifactIndexConfig,
  type WorkspaceArtifactIndexRun,
  type IndexedWorkspaceArtifact,
  type WorkspaceArtifactSearchOptions,
  type WorkspaceArtifactSearchResult,
} from './workspaceArtifactIndexService';

// Memory Notification (Phase 3 - learning notifications)
export {
  notifyMemoryLearned,
  requestMemoryConfirmation,
  handleMemoryConfirmResponse,
  needsUserConfirmation,
} from './memoryNotification';


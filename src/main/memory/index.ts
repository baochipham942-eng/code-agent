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
  initSessionSummarizerWithLLM,
  type SessionSummary,
  type SummarizerConfig,
} from './sessionSummarizer';

// LLM Summarizer (Week 4 Enhancement)
export {
  LLMSummarizer,
  getLLMSummarizer,
  initLLMSummarizer,
  createLLMSummarizer,
  type LLMSummarizerConfig,
} from './llmSummarizer';

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

// Pattern Extractor
export {
  PatternExtractor,
  getPatternExtractor,
  createPatternExtractor,
  type PatternType,
  type ExtractedPattern,
  type ToolExecution,
  type ExtractionConfig,
} from './patternExtractor';

// Skill Synthesizer
export {
  SkillSynthesizer,
  getSkillSynthesizer,
  createSkillSynthesizer,
  type SkillType,
  type SynthesizedSkill,
  type SkillTrigger,
  type SkillContent,
  type SkillUsageTracking,
  type SynthesisConfig,
} from './skillSynthesizer';

// Continuous Learning Service
export {
  ContinuousLearningService,
  getContinuousLearningService,
  createContinuousLearningService,
  type LearningResult,
  type LearningConfig,
  type SkillRecommendation,
} from './continuousLearningService';

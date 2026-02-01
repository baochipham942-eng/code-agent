// ============================================================================
// Evolution Module - Gen8 自进化系统
// ============================================================================

// Trace Recorder - 轨迹记录
export {
  getTraceRecorder,
  TraceRecorder,
  type ExecutionTrace,
  type ToolCallWithResult,
  type PlanningStep,
  type TraceMetrics,
  type TraceOutcome,
} from './traceRecorder';

// Outcome Detector - 成功判定
export {
  getOutcomeDetector,
  OutcomeDetector,
  type OutcomeSignal,
  type OutcomeResult,
  type SignalType,
} from './outcomeDetector';

// LLM Insight Extractor - LLM 洞察提取
export {
  getLLMInsightExtractor,
  LLMInsightExtractor,
  type InsightCandidate,
  type Insight,
  type InsightType,
  type TraceCluster,
  type ToolPattern,
  type InferredPreference,
} from './llmInsightExtractor';

// Safe Injector - 安全注入
export {
  getSafeInjector,
  SafeInjector,
  InjectionLayer,
  type InjectionConfig,
  type Conflict,
  type InjectedContent,
} from './safeInjector';

// Skill Evolution Service - Skill 自创建
export {
  getSkillEvolutionService,
  SkillEvolutionService,
  type ParsedSkill,
  type SkillProposal,
  type ValidationResult,
} from './skillEvolutionService';

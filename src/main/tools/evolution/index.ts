// ============================================================================
// Evolution Tools - 自我进化工具
// ============================================================================

export { strategyOptimizeTool } from './strategyOptimize';
export { toolCreateTool } from './toolCreate';
export { selfEvaluateTool } from './selfEvaluate';
export { learnPatternTool } from './learnPattern';
export { codeExecuteTool } from './codeExecute';
export { queryMetricsTool } from './queryMetrics';
export { autoPersistTools, loadPersistedTools, persistTool } from './toolCreate';

// Meta Learning Loop
export {
  getMetaLearningLoop,
  type SessionAnalysis,
  type ToolExecution,
  type ExtractedPattern,
  type LearningResult,
} from './metaLearningLoop';

// Capability Gap Detector
export {
  getCapabilityGapDetector,
  initCapabilityGapDetector,
  type CapabilityGap,
  type GapCategory,
  type GapAnalysisResult,
  type GapStatistics,
} from './capabilityGapDetector';

// Gen8 Self-Evolution Module
export * from '../../evolution';

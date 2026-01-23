// ============================================================================
// Planning System - Main exports
// ============================================================================

export * from './types';
export { PlanManager } from './planManager';
export { HooksEngine } from './hooksEngine';
export { ErrorTracker } from './errorTracker';
export { FindingsManager } from './findingsManager';
export {
  PlanningService,
  createPlanningService,
  type PlanningServiceOptions,
} from './planningService';
export {
  TaskComplexityAnalyzer,
  taskComplexityAnalyzer,
  type TaskComplexity,
  type ComplexityAnalysis,
} from './taskComplexityAnalyzer';

// Hooks dual-channel system
export * from './hooks';
export { matchers, matchTool, matchCategory } from './matchers';

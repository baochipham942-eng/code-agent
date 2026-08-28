// ============================================================================
// CI / Eval-Driven Development Module
// ============================================================================

export { ChangeDetector } from '../../agent/changeDetector';
export type { ChangeDetectionResult } from '../../agent/changeDetector';
export { BaselineManager } from './baselineManager';
export { TrendTracker } from './trendTracker';
export { generateDeltaMarkdown, generateDeltaConsole } from './deltaReporter';

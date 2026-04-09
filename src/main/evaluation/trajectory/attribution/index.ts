// ============================================================================
// Trajectory Failure Attribution — Barrel Export
// Self-Evolving v2.5 Phase 2
// ============================================================================

export { attributeByRules } from './ruleAttributor';
export { attributeByLLM, type ChatFn } from './llmAttributor';
export { matchRegressionCases, defaultRegressionCasesDir } from './regressionMatcher';
export { FailureAttributor, type AttributeOptions } from './failureAttributor';

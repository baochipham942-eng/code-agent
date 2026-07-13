// ============================================================================
// Agent Auto-Testing Framework
// ============================================================================

// Test case loading
export {
  loadAllTestSuites,
  filterTestCases,
} from './testCaseLoader';

// Test runner
export {
  TestRunner,
  createDefaultConfig,
} from './testRunner';

// Agent adapters
export {
  MockAgentAdapter,
  StandaloneAgentAdapter,
} from './agentAdapter';

// Report generation
export {
  generateConsoleReport,
  saveReport,
} from './reportGenerator';

// P2: A/B Comparison
export * from './comparator';

// P4: Eval Self-Evolution Critic
export * from './evalCritic';

// P5: CI / Eval-Driven Development
export * from './ci';

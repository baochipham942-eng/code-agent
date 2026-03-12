// ============================================================================
// Agent Auto-Testing Framework
// ============================================================================
//
// This module provides automated testing capabilities for Code Agent.
// Tests are defined in YAML files and executed automatically on session start.
//
// Usage:
//   1. Create test cases in .claude/test-cases/*.yaml
//   2. Set AUTO_TEST=true environment variable
//   3. Start Code Agent - tests run automatically
//   4. Check results in .claude/test-results/
//
// Environment variables:
//   AUTO_TEST=true                     Enable auto-testing
//   AUTO_TEST_CASES_DIR=<path>         Custom test cases directory
//   AUTO_TEST_RESULTS_DIR=<path>       Custom results directory
//   AUTO_TEST_TAGS=tag1,tag2           Filter by tags
//   AUTO_TEST_IDS=test1,test2          Filter by test IDs
//   AUTO_TEST_STOP_ON_FAILURE=true     Stop on first failure
//   AUTO_TEST_VERBOSE=true             Verbose output
//   AUTO_TEST_GENERATION=gen4          Generation to test
//   AUTO_TEST_PROVIDER=deepseek        Model provider
//   AUTO_TEST_MODEL=deepseek-chat      Model name
//
// ============================================================================

// Types
export type {
  TestCase,
  TestCaseType,
  TestSuite,
  TestResult,
  TestRunSummary,
  TestRunnerConfig,
  TestExpectations,
  ToolExecutionRecord,
  TestEvent,
  TestEventListener,
  TestStatus,
  // P1: Expectation-Based Assertions
  TestDifficulty,
  TestCategory,
  ExpectationType,
  Expectation,
  ExpectationResult,
  // P2: A/B Comparison
  CompareConfiguration,
  DualRubricScore,
  CaseComparison,
  ComparisonResult,
  // P3: Trajectory Analysis
  TrajectoryStep,
  DeviationMarker,
  RecoveryPattern,
  TrajectoryEfficiency,
  Trajectory,
  TrajectoryDiff,
  // P4: Eval Self-Evolution
  AssertionQuality,
  CoverageGap,
  EvalSuggestion,
  EvalFeedback,
  EvalHistoryEntry,
  EvalHistory,
  // P5: CI / EDD
  EvalBaseline,
  BaselineDelta,
  TrendDataPoint,
} from './types';

// Test case loading
export {
  loadTestSuite,
  loadAllTestSuites,
  filterTestCases,
  sortByDependencies,
} from './testCaseLoader';

// Assertions
export {
  runAssertions,
  runExpectations,
  type AssertionResult,
  type AssertionFailure,
} from './assertionEngine';

// Test runner
export {
  TestRunner,
  createDefaultConfig,
  type AgentInterface,
} from './testRunner';

// Agent adapters
export {
  AgentLoopAdapter,
  MockAgentAdapter,
  StandaloneAgentAdapter,
} from './agentAdapter';

// Report generation
export {
  generateMarkdownReport,
  generateJsonReport,
  generateConsoleReport,
  saveReport,
} from './reportGenerator';

// Auto-test hook
export {
  isAutoTestEnabled,
  getAutoTestConfig,
  runAutoTests,
  createAutoTestHookConfig,
} from './autoTestHook';

// P2: A/B Comparison
export * from './comparator';

// P4: Eval Self-Evolution Critic
export * from './evalCritic';

// P5: CI / Eval-Driven Development
export * from './ci';

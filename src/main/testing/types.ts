// ============================================================================
// Agent Auto-Testing Framework - Type Definitions
// ============================================================================

/**
 * Test case types
 */
export type TestCaseType =
  | 'tool'           // Test individual tool execution
  | 'task'           // Test complete task completion
  | 'conversation'   // Test conversation understanding
  | 'error_handling' // Test error recovery
  | 'multi_step';    // Test multi-step workflows

/**
 * Test case status
 */
export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/**
 * Expected tool call
 */
export interface ExpectedToolCall {
  /** Tool name (supports regex) */
  tool?: string;
  /** Expected success */
  success?: boolean;
  /** Output should contain these strings */
  output_contains?: string[];
  /** Output should NOT contain these strings */
  output_not_contains?: string[];
  /** Arguments should match (partial) */
  args_match?: Record<string, unknown>;
}

/**
 * Expected file operations
 */
export interface ExpectedFiles {
  /** Files that should be created */
  files_created?: string[];
  /** Files that should be modified */
  files_modified?: string[];
  /** File content assertions */
  file_contains?: Record<string, string | string[]>;
  /** Files that should NOT exist */
  files_not_exist?: string[];
}

/**
 * Expected error handling
 */
export interface ExpectedErrorHandling {
  /** Agent should handle error gracefully */
  error_handled?: boolean;
  /** Agent should not crash */
  no_crash?: boolean;
  /** Should contain error message */
  error_message_contains?: string[];
  /** Should retry */
  should_retry?: boolean;
}

/**
 * Expected conversation behavior
 */
export interface ExpectedConversation {
  /** Response should contain */
  response_contains?: string[];
  /** Response should NOT contain */
  response_not_contains?: string[];
  /** Should ask clarifying question */
  asks_clarification?: boolean;
  /** Should use todo list */
  uses_todo?: boolean;
}

/**
 * Test case expectations
 */
export interface TestExpectations extends
  ExpectedToolCall,
  ExpectedFiles,
  ExpectedErrorHandling,
  ExpectedConversation {
  /** Maximum number of turns allowed */
  max_turns?: number;
  /** Minimum number of tool calls */
  min_tool_calls?: number;
  /** Maximum number of tool calls */
  max_tool_calls?: number;
}

/**
 * Single test case definition
 */
export interface TestCase {
  /** Unique identifier */
  id: string;
  /** Test type */
  type: TestCaseType;
  /** Human-readable description */
  description: string;
  /** The prompt to send to the agent */
  prompt: string;
  /** Expected results */
  expect: TestExpectations;
  /** Setup commands to run before test */
  setup?: string[];
  /** Cleanup commands to run after test */
  cleanup?: string[];
  /** Timeout in milliseconds */
  timeout?: number;
  /** Tags for filtering */
  tags?: string[];
  /** Skip this test */
  skip?: boolean;
  /** Only run this test */
  only?: boolean;
  /** Dependencies - other test IDs that must pass first */
  depends_on?: string[];
}

/**
 * Test suite definition (loaded from YAML)
 */
export interface TestSuite {
  /** Suite name */
  name: string;
  /** Suite description */
  description?: string;
  /** Test cases */
  cases: TestCase[];
  /** Default timeout for all cases */
  default_timeout?: number;
  /** Global setup */
  setup?: string[];
  /** Global cleanup */
  cleanup?: string[];
  /** Suite tags */
  tags?: string[];
}

/**
 * Tool execution record (from agent)
 */
export interface ToolExecutionRecord {
  /** Tool name */
  tool: string;
  /** Input parameters */
  input: Record<string, unknown>;
  /** Output/result */
  output: string;
  /** Success status */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Execution duration in ms */
  duration: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * Single test result
 */
export interface TestResult {
  /** Test case ID */
  testId: string;
  /** Test case description */
  description: string;
  /** Status */
  status: TestStatus;
  /** Duration in ms */
  duration: number;
  /** Start time */
  startTime: number;
  /** End time */
  endTime: number;
  /** Tool executions during test */
  toolExecutions: ToolExecutionRecord[];
  /** Agent responses */
  responses: string[];
  /** Failure reason if failed */
  failureReason?: string;
  /** Detailed failure info */
  failureDetails?: {
    expected: unknown;
    actual: unknown;
    assertion: string;
  };
  /** Any errors/exceptions */
  errors: string[];
  /** Number of agent turns */
  turnCount: number;
}

/**
 * Test run summary
 */
export interface TestRunSummary {
  /** Run ID */
  runId: string;
  /** Start time */
  startTime: number;
  /** End time */
  endTime: number;
  /** Total duration */
  duration: number;
  /** Total test count */
  total: number;
  /** Passed count */
  passed: number;
  /** Failed count */
  failed: number;
  /** Skipped count */
  skipped: number;
  /** Individual results */
  results: TestResult[];
  /** Environment info */
  environment: {
    generation: string;
    model: string;
    provider: string;
    workingDirectory: string;
  };
  /** Performance stats */
  performance: {
    avgResponseTime: number;
    maxResponseTime: number;
    totalToolCalls: number;
    totalTurns: number;
  };
}

/**
 * Test runner configuration
 */
export interface TestRunnerConfig {
  /** Directory containing test cases */
  testCaseDir: string;
  /** Directory for test results */
  resultsDir: string;
  /** Working directory for tests */
  workingDirectory: string;
  /** Default timeout */
  defaultTimeout: number;
  /** Stop on first failure */
  stopOnFailure: boolean;
  /** Filter by tags */
  filterTags?: string[];
  /** Filter by test IDs */
  filterIds?: string[];
  /** Verbose logging */
  verbose: boolean;
  /** Parallel execution (future) */
  parallel: boolean;
  /** Max parallel tests */
  maxParallel: number;
}

/**
 * Test event for real-time updates
 */
export type TestEvent =
  | { type: 'suite_start'; suite: string; totalCases: number }
  | { type: 'case_start'; testId: string; description: string }
  | { type: 'case_end'; result: TestResult }
  | { type: 'suite_end'; summary: TestRunSummary }
  | { type: 'tool_call'; testId: string; tool: string; input: unknown }
  | { type: 'tool_result'; testId: string; tool: string; success: boolean }
  | { type: 'error'; testId?: string; error: string };

/**
 * Test event listener
 */
export type TestEventListener = (event: TestEvent) => void;

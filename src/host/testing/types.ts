// ============================================================================
// Agent Auto-Testing Framework - Type Definitions
// ============================================================================

import type { TelemetryCompleteness, ScoreAuthority } from '../../shared/contract/evaluation';
import type { AgentPointerEvent } from '../../shared/contract/desktop';

export type { ScoreAuthority } from '../../shared/contract/evaluation';

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
/**
 * infra_excluded（WP1-2）：429/超时/5xx/网络等基础设施故障，非 agent 能力信号，
 * 不进能力通过率分母、不进 baseline 对账，报告单列。
 */
export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'partial' | 'infra_excluded';

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
  /** Files that should exist (path check only) */
  file_exists?: string[];
  /** File content should NOT contain these strings */
  file_not_contains?: Record<string, string | string[]>;
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
  /** Run command and check exit code 0 */
  test_pass?: string;
  /** Any of these tools being called counts as pass (supports regex) */
  tools_any_of?: string[];
  /** GAIA 式判分：提取 "FINAL ANSWER: X" 与真值做 quasi-exact match */
  final_answer?: string;
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
  /** The prompt to send to the agent (single-turn) */
  prompt: string;
  /** Additional prompts for multi-turn conversations (sent sequentially after first prompt) */
  follow_up_prompts?: string[];
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
  /** Reference solution to prove task is solvable */
  reference_solution?: string;
  /** Difficulty level for categorization */
  difficulty?: TestDifficulty;
  /** Test category */
  category?: TestCategory;
  /** Expectation-based assertions (P1) */
  expectations?: Expectation[];
  /** Rotation metadata for test lifecycle */
  rotation?: { introduced: string; retire_after?: string; variant?: number };
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

export interface RealAgentRunTelemetryGate {
  name: 'real-agent-run';
  passed: boolean;
  failures: string[];
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
  /** Assertion score (0.0 - 1.0) */
  score: number;
  /** 评分权威桶：分数由确定性断言 / LLM judge / 无外部验证背书 */
  scoreAuthority?: ScoreAuthority;
  /** Pipeline failure stage (from failure funnel analysis) */
  failureStage?: string;
  /** Reference solution if provided */
  reference_solution?: string;
  /** Expectation-based assertion results (P1) */
  expectationResults?: ExpectationResult[];
  /** Trajectory analysis data (P3) */
  trajectory?: Trajectory;
  /** Trial results when trialsPerCase > 1 */
  trials?: Array<{
    score: number;
    status: TestStatus;
    duration_ms: number;
    sessionId?: string;
    replayKey?: string;
    telemetryCompleteness?: TelemetryCompleteness;
    telemetryGate?: RealAgentRunTelemetryGate;
    failureStage?: string;
    failureReason?: string;
    errors?: string[];
  }>;
  /** Statistical variance of trial scores (when trialsPerCase > 1) */
  variance?: number;
  /** Standard deviation of trial scores (when trialsPerCase > 1) */
  stdDev?: number;
  /** Whether the case is unstable (stdDev > threshold) */
  unstable?: boolean;
  /** Session ID from the agent that ran this test */
  sessionId?: string;
  /** Replay key derived from the session trace identity */
  replayKey?: string;
  /** Telemetry/replay completeness gathered from structured replay */
  telemetryCompleteness?: TelemetryCompleteness;
  /** Hard gate used by real-agent-run eval cases */
  telemetryGate?: RealAgentRunTelemetryGate;
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
  /** Partial pass count */
  partial: number;
  /** 基础设施故障排除数（429/超时/5xx/网络），不进能力分母 */
  infraExcluded?: number;
  /** Average score across non-skipped tests (0.0 - 1.0) */
  averageScore: number;
  /** Individual results */
  results: TestResult[];
  /** Environment info */
  environment: {
    model: string;
    provider: string;
    workingDirectory: string;
    /** roadmap 2.4 A/B 归因（audit D-R3）：provider 变体臂，
     *  由 CODE_AGENT_DISABLE_PROVIDER_VARIANT 决定 */
    providerVariantArm?: 'variant-on' | 'variant-off';
  };
  /** Performance stats */
  performance: {
    avgResponseTime: number;
    maxResponseTime: number;
    totalToolCalls: number;
    totalTurns: number;
  };
  /** Eval self-evolution feedback (P4) */
  evalFeedback?: EvalFeedback;
  /** Git commit hash at time of test run */
  gitCommit?: string;
  /** Warning message if DB persistence failed (best-effort save) */
  persistenceWarning?: string;
  /** 若被 circuit breaker 熔断（如余额不足），标记为 true，剩余 case 不再执行 */
  aborted?: boolean;
  /** 熔断原因（error message），用于 UI 明确显示失败而非"像未运行" */
  abortReason?: string;
  /** Number of cases with stdDev > threshold (stability metric) */
  unstableCaseCount?: number;
  /** Mean stdDev across all cases with trials (stability metric) */
  averageStdDev?: number;
  /** GAP-017: 本次 run 使用的 harness 配置（对照实验维度，落 DB config_json） */
  harness?: HarnessVariantConfig;
  /** WP1-4: 本次 run 登记的 prompt 改动预测（deltaReporter 对账用） */
  prediction?: EvalPrediction;
}

// ============================================================================
// GAP-017: Harness 对照实验（固定模型，变 harness 配置）
// ============================================================================

/**
 * Harness 配置维度 — 课程 H2："同一模型在不同 Harness 中的差距 > 不同模型在
 * 同一 Harness 中的差距"。固定模型跑多个 harness 变体做 ablation 对比。
 */
export interface HarnessVariantConfig {
  /** 变体名（用于实验命名和 DB 对比，如 "compression-off" / "hooks-on"） */
  name: string;
  /** context 自动压缩开/关（undefined = 跟随全局配置） */
  contextCompression?: boolean;
  /** hooks 开/关（undefined = 评测默认关闭） */
  hooksEnabled?: boolean;
  /** 工具集维度：'all' 全量加载 | 'deferred' 延迟加载（裁剪模型可见工具面） */
  toolMode?: 'all' | 'deferred';
}

/**
 * WP1-4：prompt 改动的预测登记 — 跑 eval 前声明预计修好/预计有风险的
 * case id 列表，deltaReporter 对账预测命中/落空/预测外翻转。
 */
export interface EvalPrediction {
  /** 预计由本次改动修好的 case id */
  predictedFixes: string[];
  /** 预计可能被本次改动打坏的 case id */
  riskTasks: string[];
}

/**
 * Test runner configuration
 */
export interface TestRunnerConfig {
  /** Optional pre-assigned runId — caller (如评测中心 IPC handler) 传入后
   *  TestRunner 不再自生 uuid，保证 DB 主键和 handler experimentId 一致，
   *  避免 handler 初始 insert + TestRunner 内部 persist 双写成两条记录。 */
  runId?: string;
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
  /** Enable trajectory analysis (P3) */
  enableTrajectoryAnalysis?: boolean;
  /** Enable eval self-critic (P4) */
  enableEvalCritic?: boolean;
  /** Use LLM for eval critic analysis (P4) */
  evalCriticUseLLM?: boolean;
  /** 工具加载模式：'all' 全量 | 'deferred' 延迟加载（默认） */
  toolMode?: 'all' | 'deferred';
  /** Number of trials per test case (default 1). When >1, each case runs multiple times for stability measurement */
  trialsPerCase?: number;
  /** GAP-017: harness 配置变体（对照实验维度，随 summary 落 DB） */
  harness?: HarnessVariantConfig;
  /** WP1-4: prompt 改动预测登记（随 summary 落盘/DB，deltaReporter 对账） */
  prediction?: EvalPrediction;
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


// ============================================================================
// Extended Evaluation System Types (Phase 1)
// ============================================================================

// === P0: Statistical Evaluation Types ===

export interface StatisticalConfig {
  runs: number;                    // default: 3
  concurrency: number;            // default: 1
  flakyThreshold: number;         // default: 0.3
}

export interface StatisticalCaseResult {
  testId: string;
  description: string;
  totalRuns: number;
  runs: TestResult[];
  scoreStats: {
    mean: number;
    stddev: number;
    min: number;
    max: number;
    median: number;
  };
  statusDistribution: {
    passed: number;
    failed: number;
    partial: number;
    skipped: number;
  };
  passAt1: number;      // single-try reliability
  passAtK: number;      // at least 1 pass in k runs
  passCaretK: number;   // all k runs pass (stability)
  isFlaky: boolean;
  avgDuration: number;
  durationStddev: number;
}

export interface StatisticalRunSummary {
  runId: string;
  config: StatisticalConfig;
  startTime: number;
  endTime: number;
  duration: number;
  caseResults: StatisticalCaseResult[];
  aggregate: {
    totalCases: number;
    totalRuns: number;
    overallPassAt1: number;
    overallPassAtK: number;
    overallPassCaretK: number;
    meanScore: number;
    scoreStddev: number;
    flakyCases: string[];
    stableCases: string[];
  };
}

// === P1: Expectation-Based Assertion Types ===

export type TestDifficulty = 'easy' | 'medium' | 'hard';

export type TestCategory = 'basic_tool' | 'task_completion' | 'error_recovery' | 'edge_case';

export type ExpectationType =
  | 'file_exists' | 'file_not_exists'
  | 'content_contains' | 'content_not_contains'
  | 'code_compiles' | 'test_passes'
  | 'output_matches' | 'command_succeeds'
  | 'response_contains' | 'response_not_contains'
  | 'tool_called' | 'tool_output_contains' | 'no_crash' | 'error_handled'
  | 'max_turns' | 'min_tool_calls' | 'max_tool_calls'
  | 'custom_script';

export interface Expectation {
  type: ExpectationType;
  description: string;
  weight?: number;           // default: 1.0
  critical?: boolean;        // failure = entire case fails
  params: Record<string, unknown>;
}

export interface ExpectationResult {
  expectation: Expectation;
  passed: boolean;
  evidence: {
    actual: unknown;
    expected: unknown;
    details?: string;
  };
  duration: number;
}

// === P2: A/B Comparison Types ===

export interface CompareConfiguration {
  name: string;
  model?: string;
  provider?: string;
  systemPrompt?: string;
  enabledTools?: string[];
  temperature?: number;
  agentConfig?: Record<string, unknown>;
}

export interface DualRubricScore {
  content: { correctness: number; completeness: number; accuracy: number; total: number };
  structure: { organization: number; formatting: number; usability: number; total: number };
  combined: number;
}

export interface CaseComparison {
  testId: string;
  description: string;
  assignment: { A: 'baseline' | 'candidate'; B: 'baseline' | 'candidate' };
  scoreA: DualRubricScore;
  scoreB: DualRubricScore;
  winner: 'A' | 'B' | 'tie';
  realWinner: 'baseline' | 'candidate' | 'tie';
  reasoning: string;
  durationA: number;
  durationB: number;
  /** WP1-3b：任一侧没跑成（infra_excluded / 零产出带错误）→ 本 pair 不进胜负统计 */
  excludedReason?: string;
}

export interface ComparisonResult {
  runId: string;
  timestamp: number;
  baseline: CompareConfiguration;
  candidate: CompareConfiguration;
  cases: CaseComparison[];
  summary: {
    totalCases: number;
    baselineWins: number;
    candidateWins: number;
    ties: number;
    baselineAvgScore: number;
    candidateAvgScore: number;
    winner: 'baseline' | 'candidate' | 'tie';
    confidence: number;
    verdict: string;
    /** WP1-3b：因一侧没跑成而排除的 pair 数（不在 totalCases 内） */
    excludedPairs?: number;
    /** 配对 sign test 双尾 p 值（只算 decisive pair；tie/excluded 不进 n） */
    pValue?: number;
  };
  duration: number;
}

// === P3: Trajectory Analysis Types ===

export interface TrajectoryStep {
  index: number;
  timestamp: number;
  type: 'tool_call' | 'decision' | 'error' | 'recovery' | 'backtrack' | 'verification';
  toolCall?: {
    name: string;
    args: Record<string, unknown>;
    result?: string;
    success: boolean;
    duration: number;
    agentPointerEvent?: AgentPointerEvent | null;
    agentPointerTimeline?: AgentPointerEvent[];
  };
  decision?: { reasoning: string; chosenAction: string };
  error?: { message: string; code?: string; recoverable: boolean };
  recovery?: { fromStepIndex: number; strategy: string; successful: boolean };
  turnNumber?: number;
  cumulativeTokens?: { input: number; output: number };
}

export interface DeviationMarker {
  stepIndex: number;
  type: 'wrong_tool' | 'unnecessary_step' | 'missed_step' | 'wrong_args' | 'hallucination' | 'loop';
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  suggestedFix?: string;
}

export interface RecoveryPattern {
  errorStepIndex: number;
  recoveryStepIndex: number;
  attempts: number;
  strategy: string;
  successful: boolean;
  tokenCost: number;
}

export interface TrajectoryEfficiency {
  totalSteps: number;
  effectiveSteps: number;
  redundantSteps: number;
  backtrackCount: number;
  totalTokens: { input: number; output: number };
  totalDuration: number;
  tokensPerEffectiveStep: number;
  efficiency: number;    // 0-1
}

export interface Trajectory {
  id: string;
  sessionId: string;
  testCaseId?: string;
  startTime: number;
  endTime: number;
  steps: TrajectoryStep[];
  deviations: DeviationMarker[];
  recoveryPatterns: RecoveryPattern[];
  efficiency: TrajectoryEfficiency;
  summary: {
    intent: string;
    outcome: 'success' | 'partial' | 'failure';
    criticalPath: number[];
    firstDeviationIndex?: number;
  };
}

export interface TrajectoryDiff {
  trajectoryA: string;
  trajectoryB: string;
  commonSteps: number;
  divergencePoint?: number;
  efficiencyDelta: { steps: number; tokens: number; duration: number };
}

// === v2.5 Phase 2: Trajectory Failure Attribution ===

export type FailureCategory =
  | 'tool_error'
  | 'bad_decision'
  | 'missing_context'
  | 'loop'
  | 'hallucination'
  | 'env_failure'
  | 'unknown';

export interface FailureRootCause {
  stepIndex: number;
  category: FailureCategory;
  summary: string;
  evidence: number[];     // related step indices
  confidence: number;     // 0-1
}

export interface CausalChainNode {
  stepIndex: number;
  role: 'root' | 'propagation' | 'terminal';
  note: string;
}

export interface FailureAttribution {
  trajectoryId: string;
  outcome: 'success' | 'partial' | 'failure';
  rootCause?: FailureRootCause;
  causalChain: CausalChainNode[];
  relatedRegressionCases: string[];  // matched reg-* case ids
  llmUsed: boolean;
  durationMs: number;
}

// === P4: Eval Self-Evolution Types ===

export interface AssertionQuality {
  assertionKey: string;
  testCaseId: string;
  quality: 'strong' | 'adequate' | 'weak' | 'unverifiable';
  discriminatingPower: number;   // 0-1
  reason: string;
  suggestion?: string;
}

export interface CoverageGap {
  testCaseId: string;
  category: 'missing_negative_test' | 'missing_edge_case' | 'missing_output_check'
           | 'untested_tool' | 'missing_file_assertion' | 'missing_error_path';
  description: string;
  priority: 'high' | 'medium' | 'low';
}

export interface EvalSuggestion {
  type: 'strengthen_assertion' | 'add_assertion' | 'remove_assertion'
      | 'add_test_case' | 'add_negative_test' | 'split_test';
  targetTestId: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
}

export interface EvalFeedback {
  runId: string;
  timestamp: number;
  testSuiteVersion: string;
  overallQualityScore: number;
  assertionQualities: AssertionQuality[];
  coverageGaps: CoverageGap[];
  suggestions: EvalSuggestion[];
  stats: {
    totalAssertions: number;
    strongAssertions: number;
    weakAssertions: number;
    unverifiableAssertions: number;
    coverageGapCount: number;
  };
}

export interface EvalHistoryEntry {
  version: string;
  parentVersion: string | null;
  timestamp: number;
  runId: string;
  testSuiteHash: string;
  metrics: {
    passRate: number;
    averageScore: number;
    totalCases: number;
    qualityScore: number;
  };
  changes?: string[];
}

export interface EvalHistory {
  currentBest: string;
  entries: EvalHistoryEntry[];
}

// === P5: CI / EDD Types ===

/** eval 运行来源：mock adapter（确定性桩，秒级）vs real 模型执行（分钟级） */
export type EvalRunMode = 'mock' | 'real';

export interface EvalBaseline {
  version: number;
  updatedAt: number;
  updatedBy: string;
  /** 晋升此 baseline 的运行来源。缺省视为历史遗留（来源不明，可能是 mock） */
  mode?: EvalRunMode;
  globalMetrics: {
    passRate: number;
    averageScore: number;
    totalCases: number;
  };
  caseResults: Record<string, {
    status: string;
    score: number;
    lastPassedAt?: number;
  }>;
  thresholds: {
    minPassRate: number;
    maxScoreDrop: number;
    maxNewFailures: number;
  };
}

export interface BaselineDelta {
  isFirstRun: boolean;
  passRateDelta: number;
  scoreDelta: number;
  newFailures: Array<{ testId: string; previousStatus: string; currentStatus: string; reason?: string }>;
  newPasses: Array<{ testId: string }>;
  isRegression: boolean;
  regressionDetails: string[];
}

export interface TrendDataPoint {
  timestamp: number;
  commitSha: string;
  scope: 'smoke' | 'full';
  passRate: number;
  averageScore: number;
  totalCases: number;
  duration: number;
  newFailures: number;
  newPasses: number;
  /** 运行来源。缺省视为历史遗留条目（mock/real 不明），在 real-only 视图中被排除 */
  mode?: EvalRunMode;
  /** WP1-2：本 run 被基础设施故障排除的 case 数（passRate 分母已排除它们） */
  infraExcluded?: number;
  /** roadmap 2.4 A/B 归因（audit D-R3）：同 commit 两臂在 trend 里靠它区分 */
  providerVariantArm?: 'variant-on' | 'variant-off';
}

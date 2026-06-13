// ============================================================================
// Evaluation Types - 会话评测类型定义
// ============================================================================

import type { UnifiedTraceIdentity, UnifiedTraceSource } from './reviewQueue';
import type {
  AgentQualityScorecard,
  TurnQualityMemorySummary,
  TurnQualityScoreSummary,
} from './turnQuality';

/**
 * 评测维度 (v3: 7 计分 + 3 信息)
 */
export enum EvaluationDimension {
  // 计分维度 (v3)
  OUTCOME_VERIFICATION = 'outcome_verification',
  CODE_QUALITY = 'code_quality',
  SECURITY = 'security',
  TOOL_EFFICIENCY = 'tool_efficiency',
  SELF_REPAIR = 'self_repair',
  VERIFICATION_QUALITY = 'verification_quality',
  FORBIDDEN_PATTERNS = 'forbidden_patterns',

  // QA 维度
  ANSWER_CORRECTNESS = 'answer_correctness',
  REASONING_QUALITY = 'reasoning_quality',
  COMMUNICATION_QUALITY = 'communication_quality',
  // Research 维度
  INFORMATION_QUALITY = 'information_quality',
  // Creation 维度
  OUTPUT_QUALITY = 'output_quality',
  REQUIREMENT_COMPLIANCE = 'requirement_compliance',

  // 信息维度 (不计分)
  EFFICIENCY_METRICS = 'efficiency_metrics',
  ERROR_TAXONOMY = 'error_taxonomy',
  PLAN_QUALITY = 'plan_quality',

  // v2 兼容 (旧数据)
  TASK_COMPLETION = 'task_completion',
  DIALOG_QUALITY = 'dialog_quality',
  PERFORMANCE = 'performance'
}

/**
 * v3 计分维度列表
 */
export const V3_SCORING_DIMENSIONS: EvaluationDimension[] = [EvaluationDimension.OUTCOME_VERIFICATION, EvaluationDimension.CODE_QUALITY, EvaluationDimension.SECURITY, EvaluationDimension.TOOL_EFFICIENCY, EvaluationDimension.SELF_REPAIR, EvaluationDimension.VERIFICATION_QUALITY, EvaluationDimension.FORBIDDEN_PATTERNS];

/**
 * v3 信息维度列表
 */
export const V3_INFO_DIMENSIONS: EvaluationDimension[] = [EvaluationDimension.EFFICIENCY_METRICS, EvaluationDimension.ERROR_TAXONOMY, EvaluationDimension.PLAN_QUALITY];

/**
 * 维度权重配置 (v3)
 */
export const DIMENSION_WEIGHTS: Partial<Record<EvaluationDimension, number>> = {
  [EvaluationDimension.OUTCOME_VERIFICATION]: 0.35,
  [EvaluationDimension.CODE_QUALITY]: 0.2,
  [EvaluationDimension.SECURITY]: 0.15,
  [EvaluationDimension.TOOL_EFFICIENCY]: 0.08,
  [EvaluationDimension.SELF_REPAIR]: 0.05,
  [EvaluationDimension.VERIFICATION_QUALITY]: 0.04,
  [EvaluationDimension.FORBIDDEN_PATTERNS]: 0.03,
  // QA 权重
  [EvaluationDimension.ANSWER_CORRECTNESS]: 0.6,
  [EvaluationDimension.REASONING_QUALITY]: 0.25,
  [EvaluationDimension.COMMUNICATION_QUALITY]: 0.15,
  // Research 权重
  [EvaluationDimension.INFORMATION_QUALITY]: 0.35,
  // Creation 权重
  [EvaluationDimension.OUTPUT_QUALITY]: 0.35,
  [EvaluationDimension.REQUIREMENT_COMPLIANCE]: 0.2,
  // v2 兼容权重
  [EvaluationDimension.TASK_COMPLETION]: 0.3,
  [EvaluationDimension.DIALOG_QUALITY]: 0.15,
  [EvaluationDimension.PERFORMANCE]: 0.1
};

/**
 * 维度中文名称
 */
export const DIMENSION_NAMES: Record<EvaluationDimension, string> = {
  [EvaluationDimension.OUTCOME_VERIFICATION]: '结果验证',
  [EvaluationDimension.CODE_QUALITY]: '代码质量',
  [EvaluationDimension.SECURITY]: '安全性',
  [EvaluationDimension.TOOL_EFFICIENCY]: '工具效率',
  [EvaluationDimension.SELF_REPAIR]: '自我修复',
  [EvaluationDimension.VERIFICATION_QUALITY]: '验证行为',
  [EvaluationDimension.FORBIDDEN_PATTERNS]: '禁止模式',
  [EvaluationDimension.ANSWER_CORRECTNESS]: '回答正确性',
  [EvaluationDimension.REASONING_QUALITY]: '推理质量',
  [EvaluationDimension.COMMUNICATION_QUALITY]: '表达质量',
  [EvaluationDimension.INFORMATION_QUALITY]: '信息质量',
  [EvaluationDimension.OUTPUT_QUALITY]: '产出质量',
  [EvaluationDimension.REQUIREMENT_COMPLIANCE]: '需求符合度',
  [EvaluationDimension.EFFICIENCY_METRICS]: '效率指标',
  [EvaluationDimension.ERROR_TAXONOMY]: '错误分类',
  [EvaluationDimension.PLAN_QUALITY]: '规划质量',
  // v2 兼容
  [EvaluationDimension.TASK_COMPLETION]: '任务完成度',
  [EvaluationDimension.DIALOG_QUALITY]: '对话质量',
  [EvaluationDimension.PERFORMANCE]: '性能指标'
};

/**
 * 维度图标
 */
export const DIMENSION_ICONS: Record<EvaluationDimension, string> = {
  [EvaluationDimension.OUTCOME_VERIFICATION]: '🎯',
  [EvaluationDimension.CODE_QUALITY]: '💻',
  [EvaluationDimension.SECURITY]: '🔒',
  [EvaluationDimension.TOOL_EFFICIENCY]: '🔧',
  [EvaluationDimension.SELF_REPAIR]: '🔄',
  [EvaluationDimension.VERIFICATION_QUALITY]: '✅',
  [EvaluationDimension.FORBIDDEN_PATTERNS]: '🚫',
  [EvaluationDimension.ANSWER_CORRECTNESS]: '🎯',
  [EvaluationDimension.REASONING_QUALITY]: '🧠',
  [EvaluationDimension.COMMUNICATION_QUALITY]: '💬',
  [EvaluationDimension.INFORMATION_QUALITY]: '📚',
  [EvaluationDimension.OUTPUT_QUALITY]: '📝',
  [EvaluationDimension.REQUIREMENT_COMPLIANCE]: '✅',
  [EvaluationDimension.EFFICIENCY_METRICS]: '⚡',
  [EvaluationDimension.ERROR_TAXONOMY]: '📋',
  [EvaluationDimension.PLAN_QUALITY]: '📐',
  // v2 兼容
  [EvaluationDimension.TASK_COMPLETION]: '✅',
  [EvaluationDimension.DIALOG_QUALITY]: '💬',
  [EvaluationDimension.PERFORMANCE]: '⚡'
};

/**
 * 子指标
 */
export interface SubMetric {
  name: string;
  value: number;
  unit?: string;
}

/**
 * 评测指标
 */
export interface EvaluationMetric {
  dimension: EvaluationDimension;
  score: number; // 0-100
  weight: number;
  subMetrics?: SubMetric[];
  details?: { reason?: string; [key: string]: unknown };
  suggestions?: string[];
  informational?: boolean; // true = 不计入总分
}

/**
 * Transcript 分析结果（代码 Grader）
 */
export interface TranscriptMetrics {
  selfRepair: {
    attempts: number;
    successes: number;
    rate: number;
    chains: Array<{
      toolName: string;
      failIndex: number;
      retryIndex: number;
      succeeded: boolean;
    }>;
  };
  verificationQuality: {
    editCount: number;
    verifiedCount: number;
    rate: number;
  };
  forbiddenPatterns: {
    detected: string[];
    count: number;
  };
  errorTaxonomy: Record<string, number>;
}

// ============================================================================
// Canonical Eval Harness Run - runner-independent result contract
// ============================================================================

export type EvalHarnessSource =
  | 'test-runner'
  | 'eval-harness'
  | 'regression'
  | 'swe-bench'
  // Legacy manual benchmark import only; not a current product/CI runner.
  | 'claude-e2e'
  | 'unknown';

export type EvalRunAggregation =
  | 'single'
  | 'best_score_pass_at_k'
  | 'median_threshold'
  | 'regression_gate'
  | 'swe_bench_gates'
  // Legacy manual benchmark import only; not a current product/CI runner.
  | 'legacy_e2e_retry'
  | 'unknown';

export type EvalCaseStatus = 'passed' | 'failed' | 'partial' | 'skipped' | 'error';

export interface CanonicalEvalTrial {
  trialIndex: number;
  status: EvalCaseStatus;
  score: number; // normalized 0-100
  durationMs: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface CanonicalEvalCase {
  id?: string;
  caseId: string;
  sessionId?: string;
  replayKey?: string;
  telemetryCompleteness?: TelemetryCompleteness;
  status: EvalCaseStatus;
  score: number; // normalized 0-100
  durationMs: number;
  failureReason?: string;
  failureStage?: string;
  trials?: CanonicalEvalTrial[];
  metadata?: Record<string, unknown>;
}

export interface CanonicalEvalRunTotals {
  total: number;
  passed: number;
  failed: number;
  partial: number;
  skipped: number;
  errored: number;
  passRate: number;
  averageScore: number;
}

export interface CanonicalEvalRun {
  schemaVersion: 1;
  runId: string;
  source: EvalHarnessSource;
  aggregation: EvalRunAggregation;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  name?: string;
  scope?: string;
  environment?: {
    generation?: string;
    model?: string;
    provider?: string;
    workingDirectory?: string;
  };
  totals: CanonicalEvalRunTotals;
  cases: CanonicalEvalCase[];
  gitCommit?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Structured Replay - shared contract for telemetry/replay consumers
// ============================================================================

export type ReplayToolCategory = 'Read' | 'Edit' | 'Write' | 'Bash' | 'Search' | 'Web' | 'Agent' | 'Skill' | 'Other';

export type ReplayDataSource = 'telemetry' | 'transcript_fallback';
export type ReplayMetricSource = 'telemetry' | 'transcript' | 'partial' | 'unavailable';

export type ReplayMetricAvailability = {
  dataSource: ReplayDataSource;
  /** @deprecated Use dataSource. */
  replaySource?: ReplayDataSource;
  toolDistribution: ReplayMetricSource;
  selfRepair: ReplayMetricSource;
  actualArgs: ReplayMetricSource;
};

export type RealAgentRunGateFailure = 'missing_session_id' | 'missing_replay_key' | 'missing_telemetry_completeness' | 'missing_telemetry_data_source' | 'transcript_fallback_replay' | 'missing_real_agent_trace' | 'missing_turns' | 'missing_model_decisions' | 'missing_tool_calls' | 'missing_event_trace' | 'missing_tool_schemas' | 'missing_replay_explanation' | 'missing_tool_args' | 'missing_tool_result';

export interface ReplayCompletenessGateInput {
  sessionId?: string | null;
  replayKey?: string | null;
  dataSource?: ReplayDataSource | string | null;
  turnCount?: number | null;
  modelCallCount?: number | null;
  toolCallCount?: number | null;
  eventCount?: number | null;
  hasModelDecisions?: boolean | null;
  hasToolSchemas?: boolean | null;
  hasReplayExplanation?: boolean | null;
  hasToolArgs?: boolean | null;
  hasToolResult?: boolean | null;
}

export function getReplayCompletenessReasons(input: ReplayCompletenessGateInput): RealAgentRunGateFailure[] {
  const failures: RealAgentRunGateFailure[] = [];

  if (!input.sessionId) failures.push('missing_session_id');
  if (!input.replayKey) failures.push('missing_replay_key');

  if (!input.dataSource) {
    failures.push('missing_telemetry_data_source');
  } else if (input.dataSource !== 'telemetry') {
    failures.push(input.dataSource === 'transcript_fallback' ? 'transcript_fallback_replay' : 'missing_telemetry_data_source');
  }

  if ((input.turnCount ?? 0) <= 0) failures.push('missing_turns');
  if ((input.modelCallCount ?? 0) <= 0 || input.hasModelDecisions !== true) {
    failures.push('missing_model_decisions');
  }
  if ((input.toolCallCount ?? 0) <= 0) failures.push('missing_tool_calls');
  if ((input.eventCount ?? 0) <= 0) failures.push('missing_event_trace');
  if (input.hasToolSchemas !== true) failures.push('missing_tool_schemas');
  if (input.hasReplayExplanation === false) failures.push('missing_replay_explanation');
  if (input.hasToolArgs === false) failures.push('missing_tool_args');
  if (input.hasToolResult === false) failures.push('missing_tool_result');

  return Array.from(new Set(failures));
}

export interface TelemetryCompleteness {
  sessionId?: string;
  replayKey?: string;
  turnCount: number;
  modelCallCount: number;
  toolCallCount: number;
  eventCount: number;
  hasSessionId?: boolean;
  hasModelDecisions: boolean;
  hasToolSchemas: boolean;
  hasPermissionTrace: boolean;
  hasContextCompressionEvents: boolean;
  hasSubagentTelemetry: boolean;
  hasRealAgentTrace?: boolean;
  dataSource?: ReplayDataSource;
  incompleteReasons?: RealAgentRunGateFailure[];
  /** @deprecated Use dataSource. */
  source?: string;
}

export interface ReplayToolSchema {
  name: string;
  inputSchema?: Record<string, unknown>;
  requiresPermission?: boolean;
  permissionLevel?: string;
}

export interface ReplayPermissionTrace {
  eventType: string;
  summary: string;
  data?: Record<string, unknown> | string;
  timestamp: number;
}

export interface ReplayModelDecision {
  id: string;
  provider: string;
  model: string;
  requestedProvider?: string;
  requestedModel?: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  reason?: string;
  billingMode?: string;
  fallbackFrom?: string | null;
  responseType?: string;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  prompt?: string;
  completion?: string;
  toolSchemas?: ReplayToolSchema[];
}

export interface ReplayMemoryAudit {
  mode: TurnQualityMemorySummary['mode'];
  blocks: TurnQualityMemorySummary['blocks'];
  suppressedEntryIds?: string[];
  offReason?: string;
  score?: TurnQualityScoreSummary;
  agentScorecard?: AgentQualityScorecard;
}

export interface ReplayTimelineEvent {
  eventType: string;
  summary: string;
  data?: Record<string, unknown> | string;
  durationMs?: number;
}

export interface ReplayToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  actualArgs?: Record<string, unknown>;
  argsSource?: 'telemetry_sanitized' | 'telemetry_actual' | 'transcript';
  toolSchema?: ReplayToolSchema;
  permissionTrace?: ReplayPermissionTrace[];
  result?: string;
  resultMetadata?: Record<string, unknown>;
  success: boolean;
  successKnown?: boolean;
  duration: number;
  category: ReplayToolCategory;
}

export interface ReplayBlock {
  type: 'user' | 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'model_call' | 'memory_audit' | 'event' | 'context_event';
  content: string;
  toolCall?: ReplayToolCall;
  modelDecision?: ReplayModelDecision;
  memoryAudit?: ReplayMemoryAudit;
  event?: ReplayTimelineEvent;
  timestamp: number;
}

export interface ReplayTurn {
  turnNumber: number;
  agentId?: string;
  turnType?: 'user' | 'iteration';
  parentTurnId?: string;
  blocks: ReplayBlock[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  startTime: number;
}

export interface ReplayFailureAttribution {
  rootCause?: {
    stepIndex: number;
    category: string;
    summary: string;
    evidence: number[];
    confidence: number;
  };
  causalChain: Array<{ stepIndex: number; role: string; note: string }>;
  relatedRegressionCases: string[];
  llmUsed: boolean;
  durationMs: number;
}

export interface StructuredReplay {
  sessionId: string;
  traceIdentity: UnifiedTraceIdentity;
  traceSource: UnifiedTraceSource;
  dataSource: ReplayDataSource;
  turns: ReplayTurn[];
  summary: {
    totalTurns: number;
    toolDistribution: Record<ReplayToolCategory, number>;
    thinkingRatio: number;
    selfRepairChains: number;
    totalDurationMs: number;
    qualityScore?: TurnQualityScoreSummary;
    agentScorecards?: AgentQualityScorecard[];
    metricAvailability?: ReplayMetricAvailability;
    telemetryCompleteness?: TelemetryCompleteness;
    deviations?: Array<{
      stepIndex: number;
      type: string;
      description: string;
      severity: string;
      suggestedFix?: string;
    }>;
    failureAttribution?: ReplayFailureAttribution;
  };
}

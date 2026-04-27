// ============================================================================
// Evaluation Types - 会话评测类型定义
// ============================================================================

import type {
  ReviewQueueItem,
  ReviewQueueSource,
  UnifiedTraceIdentity,
  UnifiedTraceSource,
} from './reviewQueue';

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
  PERFORMANCE = 'performance',
}

/**
 * v3 计分维度列表
 */
export const V3_SCORING_DIMENSIONS: EvaluationDimension[] = [
  EvaluationDimension.OUTCOME_VERIFICATION,
  EvaluationDimension.CODE_QUALITY,
  EvaluationDimension.SECURITY,
  EvaluationDimension.TOOL_EFFICIENCY,
  EvaluationDimension.SELF_REPAIR,
  EvaluationDimension.VERIFICATION_QUALITY,
  EvaluationDimension.FORBIDDEN_PATTERNS,
];

/**
 * v3 信息维度列表
 */
export const V3_INFO_DIMENSIONS: EvaluationDimension[] = [
  EvaluationDimension.EFFICIENCY_METRICS,
  EvaluationDimension.ERROR_TAXONOMY,
  EvaluationDimension.PLAN_QUALITY,
];

/**
 * 维度权重配置 (v3)
 */
export const DIMENSION_WEIGHTS: Partial<Record<EvaluationDimension, number>> = {
  [EvaluationDimension.OUTCOME_VERIFICATION]: 0.35,
  [EvaluationDimension.CODE_QUALITY]: 0.20,
  [EvaluationDimension.SECURITY]: 0.15,
  [EvaluationDimension.TOOL_EFFICIENCY]: 0.08,
  [EvaluationDimension.SELF_REPAIR]: 0.05,
  [EvaluationDimension.VERIFICATION_QUALITY]: 0.04,
  [EvaluationDimension.FORBIDDEN_PATTERNS]: 0.03,
  // QA 权重
  [EvaluationDimension.ANSWER_CORRECTNESS]: 0.60,
  [EvaluationDimension.REASONING_QUALITY]: 0.25,
  [EvaluationDimension.COMMUNICATION_QUALITY]: 0.15,
  // Research 权重
  [EvaluationDimension.INFORMATION_QUALITY]: 0.35,
  // Creation 权重
  [EvaluationDimension.OUTPUT_QUALITY]: 0.35,
  [EvaluationDimension.REQUIREMENT_COMPLIANCE]: 0.20,
  // v2 兼容权重
  [EvaluationDimension.TASK_COMPLETION]: 0.30,
  [EvaluationDimension.DIALOG_QUALITY]: 0.15,
  [EvaluationDimension.PERFORMANCE]: 0.10,
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
  [EvaluationDimension.PERFORMANCE]: '性能指标',
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
  [EvaluationDimension.PERFORMANCE]: '⚡',
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
 * 评测等级
 */
export type EvaluationGrade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

/**
 * 等级颜色配置
 */
export const GRADE_COLORS: Record<EvaluationGrade, string> = {
  S: 'text-purple-400',
  A: 'text-green-400',
  B: 'text-blue-400',
  C: 'text-yellow-400',
  D: 'text-orange-400',
  F: 'text-red-400',
};

export const GRADE_BG_COLORS: Record<EvaluationGrade, string> = {
  S: 'bg-purple-500/20',
  A: 'bg-green-500/20',
  B: 'bg-blue-500/20',
  C: 'bg-yellow-500/20',
  D: 'bg-orange-500/20',
  F: 'bg-red-500/20',
};

/**
 * 统计信息
 */
export interface EvaluationStatistics {
  duration: number; // ms
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

/**
 * 基线对比结果
 */
export interface BaselineComparison {
  delta: number; // 与基线的分差
  baselineScore: number; // 基线分数
  regressions: string[]; // 退化维度
  improvements: string[]; // 改善维度
}

/**
 * Transcript 分析结果（代码 Grader）
 */
export interface TranscriptMetrics {
  selfRepair: {
    attempts: number;
    successes: number;
    rate: number;
    chains: Array<{ toolName: string; failIndex: number; retryIndex: number; succeeded: boolean }>;
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

/**
 * 评测结果
 */
export interface EvaluationResult {
  id: string;
  sessionId: string;
  replayKey?: string;
  timestamp: number;
  overallScore: number; // 加权平均 0-100
  grade: EvaluationGrade;
  metrics: EvaluationMetric[];
  statistics: EvaluationStatistics;
  topSuggestions: string[];
  aiSummary?: string;
  transcriptMetrics?: TranscriptMetrics;
  telemetryCompleteness?: TelemetryCompleteness;
  baselineComparison?: BaselineComparison;
  // 版本化追溯 (Phase 2)
  snapshotId?: string;
  evalVersion?: string;       // 'v1' | 'legacy'
  rubricVersion?: string;
  judgeModel?: string;
  judgePromptHash?: string;
  trajectoryAnalysis?: {
    deviations: Array<{
      stepIndex: number;
      type: string;
      description: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      suggestedFix?: string;
    }>;
    efficiency: {
      totalSteps: number;
      effectiveSteps: number;
      redundantSteps: number;
      efficiency: number;
    };
    recoveryPatterns: Array<{
      errorStepIndex: number;
      recoveryStepIndex: number;
      attempts: number;
      strategy: string;
      successful: boolean;
    }>;
    outcome: 'success' | 'partial' | 'failure';
    // v2.5 Phase 2: Failure attribution (镜像 FailureAttribution，见 src/main/testing/types.ts)
    failureAttribution?: {
      rootCause?: {
        stepIndex: number;
        category:
          | 'tool_error'
          | 'bad_decision'
          | 'missing_context'
          | 'loop'
          | 'hallucination'
          | 'env_failure'
          | 'unknown';
        summary: string;
        evidence: number[];
        confidence: number;
      };
      causalChain: Array<{
        stepIndex: number;
        role: 'root' | 'propagation' | 'terminal';
        note: string;
      }>;
      relatedRegressionCases: string[];
      llmUsed: boolean;
      durationMs: number;
    };
  };
}

// ============================================================================
// Canonical Eval Harness Run - runner-independent result contract
// ============================================================================

export type EvalHarnessSource =
  | 'test-runner'
  | 'eval-harness'
  | 'regression'
  // Legacy manual benchmark import only; not a current product/CI runner.
  | 'claude-e2e'
  | 'unknown';

export type EvalRunAggregation =
  | 'single'
  | 'best_score_pass_at_k'
  | 'median_threshold'
  | 'regression_gate'
  // Legacy manual benchmark import only; not a current product/CI runner.
  | 'legacy_e2e_retry'
  | 'unknown';

export type EvalCaseStatus =
  | 'passed'
  | 'failed'
  | 'partial'
  | 'skipped'
  | 'error';

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

export type ReplayToolCategory =
  | 'Read'
  | 'Edit'
  | 'Write'
  | 'Bash'
  | 'Search'
  | 'Web'
  | 'Agent'
  | 'Skill'
  | 'Other';

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

export type RealAgentRunGateFailure =
  | 'missing_session_id'
  | 'missing_replay_key'
  | 'missing_telemetry_completeness'
  | 'missing_telemetry_data_source'
  | 'transcript_fallback_replay'
  | 'missing_real_agent_trace'
  | 'missing_turns'
  | 'missing_model_decisions'
  | 'missing_tool_calls'
  | 'missing_event_trace'
  | 'missing_tool_schemas'
  | 'missing_replay_explanation'
  | 'missing_tool_args'
  | 'missing_tool_result';

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

export function getReplayCompletenessReasons(
  input: ReplayCompletenessGateInput
): RealAgentRunGateFailure[] {
  const failures: RealAgentRunGateFailure[] = [];

  if (!input.sessionId) failures.push('missing_session_id');
  if (!input.replayKey) failures.push('missing_replay_key');

  if (!input.dataSource) {
    failures.push('missing_telemetry_data_source');
  } else if (input.dataSource !== 'telemetry') {
    failures.push(input.dataSource === 'transcript_fallback'
      ? 'transcript_fallback_replay'
      : 'missing_telemetry_data_source');
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

const REPLAY_DATA_SOURCE_LABELS: Record<ReplayDataSource, string> = {
  telemetry: 'Telemetry',
  transcript_fallback: 'Transcript fallback',
};

const REPLAY_ARGS_SOURCE_LABELS: Record<ReplayToolCall['argsSource'] & string, string> = {
  telemetry_actual: 'actual telemetry',
  telemetry_sanitized: 'sanitized telemetry',
  transcript: 'transcript',
};

export function getReplayDataSourceLabel(source: ReplayDataSource): string {
  return REPLAY_DATA_SOURCE_LABELS[source];
}

export function getReplayArgsSourceLabel(source: ReplayToolCall['argsSource']): string {
  return source ? REPLAY_ARGS_SOURCE_LABELS[source] : 'unknown';
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
  responseType?: string;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  prompt?: string;
  completion?: string;
  toolSchemas?: ReplayToolSchema[];
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
  type: 'user' | 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error' | 'model_call' | 'event' | 'context_event';
  content: string;
  toolCall?: ReplayToolCall;
  modelDecision?: ReplayModelDecision;
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

export interface EvalCenterSessionInfo {
  title: string;
  modelProvider: string;
  modelName: string;
  startTime: number;
  endTime?: number;
  generationId?: string;
  workingDirectory: string;
  status: string;
  turnCount: number;
  totalTokens: number;
  estimatedCost: number;
}

export interface EvalCenterReviewQueueState {
  items: ReviewQueueItem[];
  queuedItem: ReviewQueueItem | null;
  isQueued: boolean;
  enqueueSource: ReviewQueueSource | null;
}

export interface EvalCenterReadFacade {
  traceIdentity: UnifiedTraceIdentity;
  traceSource: UnifiedTraceSource;
  dataSource: ReplayDataSource | null;
  enqueueSource: ReviewQueueSource | null;
  metricAvailability: ReplayMetricAvailability | null;
  sessionInfo: EvalCenterSessionInfo | null;
  reviewQueueState: EvalCenterReviewQueueState;
  structuredReplay: StructuredReplay | null;
}

export interface BuildEvalCenterReadFacadeInput {
  sessionId: string;
  sessionInfo?: EvalCenterSessionInfo | null;
  structuredReplay?: StructuredReplay | null;
  reviewQueueItems?: ReviewQueueItem[];
}

function buildFallbackSessionTraceIdentity(sessionId: string): UnifiedTraceIdentity {
  return {
    traceId: `session:${sessionId}`,
    traceSource: 'session_replay',
    source: 'session_replay',
    sessionId,
    replayKey: sessionId,
  };
}

export function buildEvalCenterReadFacade(input: BuildEvalCenterReadFacadeInput): EvalCenterReadFacade {
  const structuredReplay = input.structuredReplay ?? null;
  const traceIdentity = structuredReplay?.traceIdentity ?? buildFallbackSessionTraceIdentity(input.sessionId);
  const traceSource = traceIdentity.traceSource ?? traceIdentity.source;
  const reviewQueueItems = input.reviewQueueItems ?? [];
  const queuedItem = reviewQueueItems.find((item) => item.sessionId === input.sessionId) ?? null;
  const enqueueSource = queuedItem?.enqueueSource ?? queuedItem?.source ?? null;
  const metricAvailability = structuredReplay?.summary.metricAvailability ?? null;

  return {
    traceIdentity,
    traceSource,
    dataSource: structuredReplay?.dataSource ?? metricAvailability?.dataSource ?? metricAvailability?.replaySource ?? null,
    enqueueSource,
    metricAvailability,
    sessionInfo: input.sessionInfo ?? null,
    reviewQueueState: {
      items: reviewQueueItems,
      queuedItem,
      isQueued: Boolean(queuedItem),
      enqueueSource,
    },
    structuredReplay,
  };
}

// ============================================================================
// EvalSnapshot - 统一评测输入快照
// ============================================================================

/**
 * 快照工具调用记录
 */
export interface SnapshotToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  turnIndex: number;
}

/**
 * 快照文件变更记录
 */
export interface SnapshotFileDiff {
  filePath: string;
  action: 'create' | 'edit' | 'delete';
  oldText?: string;
  newText?: string;
}

/**
 * 快照验证动作记录
 */
export interface SnapshotVerification {
  type: 'bash_test' | 'typecheck' | 'manual_check' | 'read_verify';
  command?: string;
  success: boolean;
  output?: string;
  timestamp: number;
}

/**
 * EvalSnapshot — 统一评测输入数据结构
 * 所有评分基于同一份快照，解决"数据平面分裂"根因
 */
export interface EvalSnapshot {
  schema_version: 1;
  // 身份
  session_id: string;
  snapshot_id: string;
  created_at: number;
  // 任务
  task_text: string;
  task_type?: string;
  // 产出
  final_answer: string;
  tool_calls: SnapshotToolCall[];
  file_diffs: SnapshotFileDiff[];
  outcome_artifacts: string[];
  // 验证
  verification_actions: SnapshotVerification[];
  // 成本
  total_input_tokens: number;
  total_output_tokens: number;
  total_tool_calls: number;
  duration_ms: number;
  estimated_cost: number;
  // 环境
  code_context?: {
    stderr_output?: string;
    exit_codes?: number[];
  };
}

/**
 * 评测导出格式
 */
export type EvaluationExportFormat = 'json' | 'markdown';

/**
 * 分数转等级
 */
export function scoreToGrade(score: number): EvaluationGrade {
  if (score >= 95) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

// ============================================================================
// Re-export from evaluationFramework.ts for backward compatibility
// ============================================================================
export {
  type ScoringDimensionConfig,
  type EvalDimensionName,
  type FailureStage,
  type FailureFunnelResult,
  type VerifierType,
  type VerifierResult,
  type TestSetTier,
  type TestCaseSource,
  type DimensionScore,
  type ExperimentSummary,
  DEFAULT_SCORING_CONFIG,
} from './evaluationFramework';

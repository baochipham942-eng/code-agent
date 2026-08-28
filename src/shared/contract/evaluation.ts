// ============================================================================
// Evaluation Types - 会话评测类型定义
// ============================================================================

import type { UnifiedTraceIdentity, UnifiedTraceSource } from './reviewQueue';
import type { AgentPointerEvent } from './desktop';
import type {
  AgentQualityScorecard,
  TurnQualityMemorySummary,
  TurnQualityScoreSummary,
} from './turnQuality';

type EvalRunEventStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'partial'
  | 'infra_excluded'
  | 'cost_exceeded'
  | 'not_run';

type EvalRunEventSummary = {
  runId: string;
  startTime: number;
  endTime: number;
  duration: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  mockExcluded?: number;
  partial: number;
  infraExcluded?: number;
  costExceeded?: number;
  averageScore: number;
  gitCommit?: string;
  persistenceWarning?: string;
  aborted?: boolean;
  abortReason?: string;
  unstableCaseCount?: number;
  averageStdDev?: number;
  dataset?: string;
};

/**
 * Stable NDJSON protocol produced by `scripts/eval-ci.ts --json-events` and
 * consumed by the host run bridge and evaluation UI. Every stdout line is one
 * event. Consumers must tolerate additive fields; changing an existing field's
 * meaning requires incrementing `schemaVersion` (the first protocol version is 1).
 */
export type EvalRunEvent =
  | {
      schemaVersion: 1;
      type: 'run_start';
      ts: number;
      runId: string;
      plannedCaseIds: string[];
      config: {
        mode: 'real' | 'mock';
        model: string;
        provider: string;
        scope: 'smoke' | 'full';
        split?: 'held-in' | 'held-out' | 'control' | 'safety';
        tags?: string[];
        ids?: string[];
        maxCases: number;
        concurrency: number;
        compare?: boolean;
        gitCommit: string;
        testCaseDir: string;
      };
    }
  | {
      schemaVersion: 1;
      type: 'case_start';
      ts: number;
      runId: string;
      testId: string;
      description: string;
    }
  | {
      schemaVersion: 1;
      type: 'case_end';
      ts: number;
      runId: string;
      testId: string;
      status: EvalRunEventStatus;
      score: number;
      durationMs: number;
      failureReason?: string;
      failureStage?: string;
      usageStatus?: 'available' | 'usage_unavailable';
      costUsd?: number;
      mockExcluded?: boolean;
      killedByTimeout?: boolean;
      trials?: number;
    }
  | {
      schemaVersion: 1;
      type: 'tool_call';
      ts: number;
      runId: string;
      testId: string;
      tool: string;
      input: unknown;
    }
  | {
      schemaVersion: 1;
      type: 'tool_result';
      ts: number;
      runId: string;
      testId: string;
      tool: string;
      success: boolean;
    }
  | {
      schemaVersion: 1;
      type: 'error';
      ts: number;
      runId: string;
      testId?: string;
      error: string;
    }
  | {
      schemaVersion: 1;
      type: 'run_end';
      ts: number;
      runId: string;
      summary: EvalRunEventSummary;
      reportFiles: string[];
      exitCode: number;
      aborted: boolean;
      abortReason?: string;
    };

/**
 * 评测维度 (v3: 7 计分 + 3 信息)
 */
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

/**
 * 评分权威三桶 — 分数由什么背书。judge/自报分不再冒充硬 pass：
 * - deterministic_assertion: 确定性断言（文件/输出/退出码等可重放证据）
 * - llm_judge: LLM 评审打分（需 judgeCalibration 校准后才可信）
 * - self_check: 无外部验证（零断言自动 pass / agent 自报成功）
 * L3 实验提案只准引用前两桶；self_check 分数不作能力证据。
 */
export type ScoreAuthority = 'deterministic_assertion' | 'llm_judge' | 'self_check';

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
  /** 分数权威桶；缺省 = 历史遗留（来源不明，不得冒充 deterministic） */
  scoreAuthority?: ScoreAuthority;
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
// Eval Experiments 只读视图 - 评测中心「基准」tab IPC 载荷
// 数据源：experiments / experiment_cases 表（ExperimentAdapter 落盘）。
// 只读查询通道（evaluation:list-experiments / evaluation:load-experiment）的
// renderer 侧契约；刻意裁剪掉 config_json / data_json 原文，避免大字段过 IPC。
// ============================================================================

export interface EvalExperimentSummary {
  total?: number;
  passed?: number;
  failed?: number;
  partial?: number;
  skipped?: number;
  errored?: number;
  /** 0-1 通过率（分母排除 skipped，见 ADR-036 F2）。 */
  passRate?: number;
  /** 0-1 均分（legacy Eval Center UI 口径）。 */
  avgScore?: number;
  duration?: number;
}

export interface EvalExperimentListItem {
  id: string;
  name: string;
  timestamp: number;
  model: string | null;
  provider: string | null;
  scope: string;
  /** 落盘来源：test-runner / eval-harness / regression。 */
  source: string;
  gitCommit: string | null;
  summary: EvalExperimentSummary | null;
}

export interface EvalExperimentCaseItem {
  caseId: string;
  status: EvalCaseStatus;
  /** 0-100 分。 */
  score: number;
  durationMs: number | null;
}

export interface EvalExperimentDetail {
  experiment: EvalExperimentListItem;
  cases: EvalExperimentCaseItem[];
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
  agentPointerEvent?: AgentPointerEvent | null;
  agentPointerTimeline?: AgentPointerEvent[];
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

export interface BrowserComputerProofTimelineEntry {
  turnNumber: number;
  toolCallId: string;
  toolName: string;
  status: string;
  summary: string;
  evidenceRefIds: string[];
  timestamp: number;
  traceId?: string | null;
  visualSource?: string | null;
  manualTakeoverStatus?: string | null;
}

export type EvidenceControlProjectionTrustLevel = 'strong' | 'partial' | 'weak';

export type EvidenceControlProjectionSource =
  | 'verification'
  | 'browser_computer'
  | 'trajectory'
  | 'background_recovery';

export interface EvidenceControlSummaryProjection {
  schemaVersion: 1;
  trustLevel: EvidenceControlProjectionTrustLevel;
  generatedAt: number;
  totalItems: number;
  totalEvidenceRefs: number;
  exportSafeItems: number;
  blockedItems: number;
  staleItems: number;
  conflictItems: number;
  bySource: Record<EvidenceControlProjectionSource, number>;
  byStatus: Record<string, number>;
  gaps: string[];
  conflicts: string[];
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
    browserComputerProofTimeline?: BrowserComputerProofTimelineEntry[];
    evidenceControl?: EvidenceControlSummaryProjection;
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

// ============================================================================
// Structured Replay - shared contract for telemetry/replay consumers
// ----------------------------------------------------------------------------
// 从 evaluation.ts 拆出（那份顶到 max-lines 上限）；消费方仍从 '@shared/contract/evaluation'
// 取，那边整体再导出（与 evaluationHarvest.ts 同一做法）。
// ============================================================================
import type { UnifiedTraceIdentity, UnifiedTraceSource } from './reviewQueue';
import type { AgentPointerEvent } from './desktop';
import type { AgentQualityScorecard, TurnQualityMemorySummary, TurnQualityScoreSummary } from './turnQuality';

export type ReplayToolCategory = 'Read' | 'Edit' | 'Write' | 'Bash' | 'Search' | 'Web' | 'Agent' | 'Skill' | 'Other';

export type ReplayDataSource = 'telemetry' | 'transcript_fallback';
type ReplayMetricSource = 'telemetry' | 'transcript' | 'partial' | 'unavailable';

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

interface ReplayTimelineEvent {
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

interface ReplayFailureAttribution {
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

type EvidenceControlProjectionTrustLevel = 'strong' | 'partial' | 'weak';

type EvidenceControlProjectionSource =
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


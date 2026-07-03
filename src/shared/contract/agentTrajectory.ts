import {
  getReplayCompletenessReasons,
  type BrowserComputerProofTimelineEntry,
  type EvidenceControlSummaryProjection,
  type ReplayBlock,
  type ReplayModelDecision,
  RealAgentRunGateFailure,
  ReplayDataSource,
  type ReplayToolCall,
  ReplayToolCategory,
  type StructuredReplay,
} from './evaluation';
import type { AgentPointerEvent } from './desktop';
import type { UnifiedTraceIdentity } from './reviewQueue';

export type AgentTrajectorySchemaVersion = 1;

export type AgentTrajectoryQualityTier = 'G0' | 'G1' | 'G2';

export type AgentTrajectoryTaskKind = 'coding' | 'search' | 'data_analysis' | 'agent_task' | 'ordinary_chat' | 'other';

export type AgentTrajectoryDatasetRole = 'core_eval' | 'diagnostic' | 'excluded';

export interface AgentTrajectoryClassification {
  taskKind: AgentTrajectoryTaskKind;
  datasetRole: AgentTrajectoryDatasetRole;
  reason: string;
  labels: string[];
}

export type AgentTrajectoryGateFailure =
  | RealAgentRunGateFailure
  | 'missing_structured_replay'
  | 'missing_assistant_final_answer'
  | 'missing_tool_definition'
  | 'missing_tool_call_id'
  | 'missing_model_provenance'
  | 'ordinary_chat_no_tool'
  | 'pending_tool_result'
  | 'unpaired_tool_call_result';

export const INCOMPLETE_TOOL_RESULT_MARKER = '[incomplete_tool_result]';

export const AGENT_TRAJECTORY_COLLECTION_METADATA_KEY = 'agentTrajectoryCollection';

export const DEFAULT_AGENT_TRAJECTORY_DATASET_VERSION = 'agent-trajectory-v1';

export type AgentTrajectoryCollectionIntent =
  | 'new_core_eval_candidate'
  | 'historical_diagnostic'
  | 'manual_review'
  | 'excluded';

export type AgentTrajectoryCollectionSource = 'quality_gate' | 'manual_review' | 'audit_backfill' | 'session_metadata';

export interface AgentTrajectoryCollectionMetadata {
  schemaVersion: AgentTrajectorySchemaVersion;
  intent: AgentTrajectoryCollectionIntent;
  taskKind: AgentTrajectoryTaskKind;
  datasetRole: AgentTrajectoryDatasetRole;
  datasetVersion: string;
  source: AgentTrajectoryCollectionSource;
  reason: string;
  failureTags: AgentTrajectoryGateFailure[];
  labels: string[];
  createdAt: number;
  updatedAt: number;
  reviewedAt?: number;
  reviewedBy?: string;
  notes?: string;
}

export type AgentTrajectoryCollectionMetadataPatch = Partial<
  Pick<
    AgentTrajectoryCollectionMetadata,
    | 'intent'
    | 'taskKind'
    | 'datasetRole'
    | 'datasetVersion'
    | 'source'
    | 'reason'
    | 'failureTags'
    | 'labels'
    | 'reviewedBy'
    | 'notes'
  >
>;

export interface AgentTrajectoryQualityGate {
  tier: AgentTrajectoryQualityTier;
  passed: boolean;
  exportReady: boolean;
  failures: AgentTrajectoryGateFailure[];
  warnings: string[];
  classification: AgentTrajectoryClassification;
  metrics: {
    turnCount: number;
    modelCallCount: number;
    toolCallCount: number;
    toolResultCount: number;
    eventCount: number;
    toolDefinitionCount: number;
    finalAnswerPresent: boolean;
    pendingToolResultCount: number;
  };
}

export interface AgentTrajectorySessionQualitySummary {
  sessionId: string;
  dataSource?: ReplayDataSource;
  traceIdentity?: UnifiedTraceIdentity;
  quality: AgentTrajectoryQualityGate;
  collection: AgentTrajectoryCollectionMetadata;
  evidenceControl?: EvidenceControlSummaryProjection;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTaskKind(value: unknown): value is AgentTrajectoryTaskKind {
  return (
    value === 'coding' ||
    value === 'search' ||
    value === 'data_analysis' ||
    value === 'agent_task' ||
    value === 'ordinary_chat' ||
    value === 'other'
  );
}

function isDatasetRole(value: unknown): value is AgentTrajectoryDatasetRole {
  return value === 'core_eval' || value === 'diagnostic' || value === 'excluded';
}

function isCollectionIntent(value: unknown): value is AgentTrajectoryCollectionIntent {
  return (
    value === 'new_core_eval_candidate' ||
    value === 'historical_diagnostic' ||
    value === 'manual_review' ||
    value === 'excluded'
  );
}

function isCollectionSource(value: unknown): value is AgentTrajectoryCollectionSource {
  return (
    value === 'quality_gate' || value === 'manual_review' || value === 'audit_backfill' || value === 'session_metadata'
  );
}

function isGateFailure(value: unknown): value is AgentTrajectoryGateFailure {
  return typeof value === 'string';
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function collectionIntentForRole(role: AgentTrajectoryDatasetRole): AgentTrajectoryCollectionIntent {
  if (role === 'core_eval') return 'new_core_eval_candidate';
  if (role === 'excluded') return 'excluded';
  return 'historical_diagnostic';
}

export function readAgentTrajectoryCollectionMetadata(
  metadata: Record<string, unknown> | undefined,
): AgentTrajectoryCollectionMetadata | undefined {
  const value = metadata?.[AGENT_TRAJECTORY_COLLECTION_METADATA_KEY];
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  if (!isTaskKind(value.taskKind) || !isDatasetRole(value.datasetRole)) return undefined;
  if (!isCollectionIntent(value.intent) || !isCollectionSource(value.source)) return undefined;
  if (typeof value.datasetVersion !== 'string' || !value.datasetVersion.trim()) return undefined;
  if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') return undefined;

  return {
    schemaVersion: 1,
    intent: value.intent,
    taskKind: value.taskKind,
    datasetRole: value.datasetRole,
    datasetVersion: value.datasetVersion,
    source: value.source,
    reason: typeof value.reason === 'string' ? value.reason : 'session_metadata',
    failureTags: Array.isArray(value.failureTags) ? value.failureTags.filter(isGateFailure) : [],
    labels: normalizeStringArray(value.labels),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    reviewedAt: typeof value.reviewedAt === 'number' ? value.reviewedAt : undefined,
    reviewedBy: typeof value.reviewedBy === 'string' ? value.reviewedBy : undefined,
    notes: typeof value.notes === 'string' ? value.notes : undefined,
  };
}

export function writeAgentTrajectoryCollectionMetadata(
  metadata: Record<string, unknown> | undefined,
  collection: AgentTrajectoryCollectionMetadata,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [AGENT_TRAJECTORY_COLLECTION_METADATA_KEY]: collection,
  };
}

export function buildAgentTrajectoryCollectionMetadata(
  quality: AgentTrajectoryQualityGate,
  options: {
    now?: number;
    datasetVersion?: string;
    source?: AgentTrajectoryCollectionSource;
  } = {},
): AgentTrajectoryCollectionMetadata {
  const now = options.now ?? Date.now();
  const datasetVersion = options.datasetVersion?.trim() || DEFAULT_AGENT_TRAJECTORY_DATASET_VERSION;
  const { taskKind, datasetRole, reason, labels } = quality.classification;
  return {
    schemaVersion: 1,
    intent: collectionIntentForRole(datasetRole),
    taskKind,
    datasetRole,
    datasetVersion,
    source: options.source ?? 'quality_gate',
    reason,
    failureTags: [...quality.failures],
    labels: unique([...labels, datasetVersion]),
    createdAt: now,
    updatedAt: now,
  };
}

export function resolveAgentTrajectoryCollectionMetadata(
  quality: AgentTrajectoryQualityGate,
  metadata: Record<string, unknown> | undefined,
  options: {
    now?: number;
    datasetVersion?: string;
    source?: AgentTrajectoryCollectionSource;
  } = {},
): AgentTrajectoryCollectionMetadata {
  const generated = buildAgentTrajectoryCollectionMetadata(quality, options);
  const existing = readAgentTrajectoryCollectionMetadata(metadata);
  if (!existing) return generated;
  return {
    ...generated,
    ...existing,
    failureTags: existing.failureTags.length > 0 ? existing.failureTags : generated.failureTags,
    labels: unique([...generated.labels, ...existing.labels]),
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
  };
}

export function mergeAgentTrajectoryCollectionMetadata(
  current: AgentTrajectoryCollectionMetadata,
  patch: AgentTrajectoryCollectionMetadataPatch,
  options: {
    now?: number;
    reviewedAt?: number;
    source?: AgentTrajectoryCollectionSource;
  } = {},
): AgentTrajectoryCollectionMetadata {
  const now = options.now ?? Date.now();
  const datasetRole = patch.datasetRole ?? current.datasetRole;
  const source = options.source ?? patch.source ?? current.source;
  const reason = patch.reason ?? (source === 'manual_review' ? 'manual_review_override' : current.reason);
  return {
    ...current,
    ...patch,
    schemaVersion: 1,
    datasetRole,
    intent: patch.intent ?? collectionIntentForRole(datasetRole),
    taskKind: patch.taskKind ?? current.taskKind,
    datasetVersion: patch.datasetVersion?.trim() || current.datasetVersion,
    source,
    reason,
    failureTags: patch.failureTags ?? current.failureTags,
    labels: unique([...(patch.labels ?? current.labels), datasetRole, patch.taskKind ?? current.taskKind]),
    createdAt: current.createdAt,
    updatedAt: now,
    reviewedAt: options.reviewedAt ?? (source === 'manual_review' ? now : current.reviewedAt),
    reviewedBy: patch.reviewedBy ?? current.reviewedBy,
    notes: patch.notes ?? current.notes,
  };
}

function getReplayBlocks(replay: StructuredReplay): ReplayBlock[] {
  return replay.turns.flatMap((turn) => turn.blocks);
}

function hasRecordArgs(toolCall: ReplayToolCall | undefined): boolean {
  if (!toolCall) return false;
  return !!toolCall.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args);
}

function hasToolResult(toolCall: ReplayToolCall | undefined): boolean {
  if (!toolCall) return false;
  return toolCall.successKnown === true && typeof toolCall.result === 'string';
}

function hasPendingCloseout(toolCall: ReplayToolCall | undefined): boolean {
  if (!toolCall) return false;
  return String(toolCall.result ?? '').includes(INCOMPLETE_TOOL_RESULT_MARKER);
}

function hasModelProvenance(modelDecision: ReplayModelDecision | undefined): boolean {
  return !!modelDecision?.provider && !!modelDecision.model;
}

function chooseTier(
  replay: StructuredReplay | null,
  failures: AgentTrajectoryGateFailure[],
): AgentTrajectoryQualityTier {
  if (!replay) return 'G0';
  if (failures.length === 0) return 'G2';

  const completeness = replay.summary.telemetryCompleteness;
  const hasTelemetryReplay =
    replay.dataSource === 'telemetry' &&
    (completeness?.turnCount ?? replay.turns.length) > 0 &&
    (completeness?.modelCallCount ?? 0) > 0 &&
    (completeness?.toolCallCount ?? 0) > 0;
  return hasTelemetryReplay ? 'G1' : 'G0';
}

function hasToolCategory(replay: StructuredReplay, categories: ReplayToolCategory[]): boolean {
  return categories.some((category) => (replay.summary.toolDistribution[category] ?? 0) > 0);
}

function classifyTaskKind(replay: StructuredReplay, toolCalls: ReplayToolCall[]): AgentTrajectoryTaskKind {
  if (toolCalls.length === 0) return 'ordinary_chat';

  const blocks = getReplayBlocks(replay);
  const searchableText = [...toolCalls.map((toolCall) => toolCall.name), ...blocks.map((block) => block.content)]
    .join(' ')
    .toLowerCase();

  if (hasToolCategory(replay, ['Search', 'Web'])) {
    return 'search';
  }
  if (
    /\b(excel|xlsx|csv|sql|pandas|data|dataset|chart|dashboard|analytics|table|metric|kpi|warehouse|query)\b/.test(
      searchableText,
    )
  ) {
    return 'data_analysis';
  }
  if (hasToolCategory(replay, ['Agent', 'Skill'])) {
    return 'agent_task';
  }
  if (
    hasToolCategory(replay, ['Read', 'Edit', 'Write', 'Bash']) ||
    /\b(package\.json|typescript|javascript|python|test|typecheck|build|repo|git|diff|patch|file|code|source|function|component|bash|npm|pnpm|yarn|tsx|tsc)\b/.test(
      searchableText,
    )
  ) {
    return 'coding';
  }
  if (hasToolCategory(replay, ['Other'])) {
    return 'agent_task';
  }
  return 'other';
}

function classifyDatasetRole(
  tier: AgentTrajectoryQualityTier,
  taskKind: AgentTrajectoryTaskKind,
): Pick<AgentTrajectoryClassification, 'datasetRole' | 'reason'> {
  if (taskKind === 'ordinary_chat') {
    return {
      datasetRole: 'excluded',
      reason: 'ordinary_chat_excluded',
    };
  }
  if (tier === 'G2') {
    return {
      datasetRole: 'core_eval',
      reason: 'g2_agent_task',
    };
  }
  return {
    datasetRole: 'diagnostic',
    reason: 'incomplete_or_historical_replay',
  };
}

function buildClassification(
  replay: StructuredReplay | null,
  tier: AgentTrajectoryQualityTier,
  toolCalls: ReplayToolCall[],
): AgentTrajectoryClassification {
  if (!replay) {
    return {
      taskKind: 'other',
      datasetRole: 'diagnostic',
      reason: 'missing_structured_replay',
      labels: ['diagnostic', 'missing_replay'],
    };
  }

  const taskKind = classifyTaskKind(replay, toolCalls);
  const role = classifyDatasetRole(tier, taskKind);
  return {
    taskKind,
    ...role,
    labels: [role.datasetRole, taskKind, tier.toLowerCase()],
  };
}

export function evaluateAgentTrajectoryReplay(replay: StructuredReplay | null): AgentTrajectoryQualityGate {
  const failures: AgentTrajectoryGateFailure[] = [];

  if (!replay) {
    return {
      tier: 'G0',
      passed: false,
      exportReady: false,
      failures: ['missing_structured_replay'],
      warnings: [],
      classification: buildClassification(null, 'G0', []),
      metrics: {
        turnCount: 0,
        modelCallCount: 0,
        toolCallCount: 0,
        toolResultCount: 0,
        eventCount: 0,
        toolDefinitionCount: 0,
        finalAnswerPresent: false,
        pendingToolResultCount: 0,
      },
    };
  }

  const blocks = getReplayBlocks(replay);
  const modelBlocks = blocks.filter((block) => block.type === 'model_call' && block.modelDecision);
  const toolBlocks = blocks.filter((block) => block.type === 'tool_call' && block.toolCall);
  const eventBlocks = blocks.filter((block) => block.type === 'event' || block.type === 'context_event');
  const finalAnswerPresent = blocks.some((block) => block.type === 'text' && block.content.trim().length > 0);
  const toolCalls = toolBlocks.map((block) => block.toolCall).filter(Boolean) as ReplayToolCall[];
  const toolResultCount = toolCalls.filter(hasToolResult).length;
  const toolDefinitionCount = toolCalls.filter((toolCall) => Boolean(toolCall.toolSchema)).length;
  const pendingToolResultCount = toolCalls.filter(hasPendingCloseout).length;
  const completeness = replay.summary.telemetryCompleteness;

  failures.push(
    ...(getReplayCompletenessReasons({
      sessionId: completeness?.sessionId ?? replay.sessionId,
      replayKey: completeness?.replayKey ?? replay.traceIdentity?.replayKey,
      dataSource: completeness?.dataSource ?? replay.dataSource,
      turnCount: completeness?.turnCount ?? replay.turns.length,
      modelCallCount: completeness?.modelCallCount ?? modelBlocks.length,
      toolCallCount: completeness?.toolCallCount ?? toolBlocks.length,
      eventCount: completeness?.eventCount ?? eventBlocks.length,
      hasModelDecisions: completeness?.hasModelDecisions ?? modelBlocks.length > 0,
      hasToolSchemas: completeness?.hasToolSchemas ?? toolDefinitionCount > 0,
      hasReplayExplanation: modelBlocks.some(
        (block) => Boolean(block.modelDecision?.prompt) || Boolean(block.modelDecision?.completion),
      ),
      hasToolArgs: toolCalls.length > 0 && toolCalls.every(hasRecordArgs),
      hasToolResult: toolCalls.length > 0 && toolCalls.every(hasToolResult),
    }) as AgentTrajectoryGateFailure[]),
  );

  if (completeness?.hasRealAgentTrace === false) {
    failures.push('missing_real_agent_trace');
  }
  if (toolCalls.length === 0) {
    failures.push('ordinary_chat_no_tool');
  }
  if (!finalAnswerPresent) {
    failures.push('missing_assistant_final_answer');
  }
  if (modelBlocks.length === 0 || modelBlocks.some((block) => !hasModelProvenance(block.modelDecision))) {
    failures.push('missing_model_provenance');
  }
  if (toolCalls.some((toolCall) => !toolCall.id)) {
    failures.push('missing_tool_call_id');
  }
  if (toolCalls.some((toolCall) => !toolCall.toolSchema)) {
    failures.push('missing_tool_definition');
  }
  if (toolCalls.some((toolCall) => !hasToolResult(toolCall))) {
    failures.push('unpaired_tool_call_result');
  }
  if (pendingToolResultCount > 0) {
    failures.push('pending_tool_result');
  }

  const uniqueFailures = unique(failures);
  const tier = chooseTier(replay, uniqueFailures);
  return {
    tier,
    passed: tier === 'G2',
    exportReady: tier === 'G2',
    failures: uniqueFailures,
    warnings: [],
    classification: buildClassification(replay, tier, toolCalls),
    metrics: {
      turnCount: replay.turns.length,
      modelCallCount: modelBlocks.length,
      toolCallCount: toolCalls.length,
      toolResultCount,
      eventCount: eventBlocks.length,
      toolDefinitionCount,
      finalAnswerPresent,
      pendingToolResultCount,
    },
  };
}

export type AgentTrajectoryStepRole =
  | 'user'
  | 'assistant'
  | 'assistant_final'
  | 'thinking'
  | 'model_call'
  | 'tool_call'
  | 'tool_result'
  | 'event'
  | 'context_event'
  | 'memory_audit'
  | 'error';

export interface AgentTrajectoryToolDefinition {
  name: string;
  inputSchema?: Record<string, unknown>;
  requiresPermission?: boolean;
  permissionLevel?: string;
}

export interface AgentTrajectoryStep {
  index: number;
  turnNumber: number;
  role: AgentTrajectoryStepRole;
  timestamp: number;
  content: string;
  model?: {
    id: string;
    provider: string;
    model: string;
    requestedProvider?: string;
    requestedModel?: string;
    resolvedProvider?: string;
    resolvedModel?: string;
    responseType?: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
  toolCall?: {
    id: string;
    name: string;
    category: ReplayToolCategory;
    args: Record<string, unknown>;
    argsSource?: string;
    hasDefinition: boolean;
    parallel?: boolean;
    agentPointerEvent?: AgentPointerEvent | null;
  };
  toolResult?: {
    toolCallId: string;
    name: string;
    success: boolean;
    result: string;
    durationMs: number;
    pendingCloseout: boolean;
    agentPointerEvent?: AgentPointerEvent | null;
    agentPointerTimeline?: AgentPointerEvent[];
  };
  event?: {
    eventType: string;
    summary: string;
    data?: Record<string, unknown> | string;
    durationMs?: number;
  };
}

export interface AgentTrajectoryEfficiency {
  totalSteps: number;
  effectiveSteps: number;
  redundantSteps: number;
  backtrackCount: number;
  totalTokens: { input: number; output: number };
  totalDuration: number;
  tokensPerEffectiveStep: number;
  efficiency: number;
}

export interface AgentTrajectory {
  schemaVersion: AgentTrajectorySchemaVersion;
  trajectoryId: string;
  sessionId: string;
  traceIdentity: UnifiedTraceIdentity;
  dataSource: ReplayDataSource;
  quality: AgentTrajectoryQualityGate;
  collection: AgentTrajectoryCollectionMetadata;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  summary: {
    turnCount: number;
    modelCallCount: number;
    toolCallCount: number;
    toolResultCount: number;
    eventCount: number;
    toolDistribution: Record<ReplayToolCategory, number>;
    models: Array<{ provider: string; model: string; count: number }>;
    finalAnswer?: string;
    browserComputerProofCount?: number;
    browserComputerProofTimeline?: BrowserComputerProofTimelineEntry[];
    evidenceControl?: EvidenceControlSummaryProjection;
  };
  efficiency?: AgentTrajectoryEfficiency;
  toolDefinitions: AgentTrajectoryToolDefinition[];
  steps: AgentTrajectoryStep[];
}

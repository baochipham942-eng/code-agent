import { z } from 'zod';

import type {
  ArtifactLocatorTelemetryEventData,
  ArtifactWriteStartedData,
  BackgroundTaskLedgerChangedData,
  BudgetEventData,
  ContextCompressedData,
  GoalGatePlannedCommand,
  GoalGateSkippedCheck,
  GoalGateVerificationCard,
  HookStartedEventData,
  HookTriggerEventData,
  InterruptEventData,
  LocalToolCallData,
  LocalToolCancelData,
  MemoryLearnedData,
  MessageDeltaData,
  MessageSnapshotData,
  ResearchCompleteData,
  ResearchDetectedData,
  ResearchErrorData,
  ResearchModeStartedData,
  ResearchProgressData,
  RoleDraftPendingData,
  RoutingResolvedEventData,
  SkillDraftPendingData,
  TaskCompleteData,
  TaskProgressData,
  TaskStatsData,
  TaskUpdateEventData,
  TeamRecipeDraftPendingData,
  ToolOutputDeltaData,
  ToolProgressData,
  ToolTimeoutData,
} from './agent';
import type { Citation } from './citation';
import type { EvidenceRef } from './evidence';
import type { Message } from './message';
import type {
  ModelDecisionEventData,
  ModelFallbackInfo,
  ModelFallbackStrategy,
  ModelFallbackToolPolicy,
  ModelFallbackTraceStep,
  ModelProviderIdentity,
  ModelToolStrategyDiagnostics,
} from './modelDecision';
import type { HostReasonPayload, PermissionRequest } from './permission';
import type { SessionTask, TodoItem } from './planning';
import type { SurfaceExecutionEventV1 } from './surfaceExecution';
import type { ToolCall, ToolResult } from './tool';
import type { TurnDiffEventData } from './turnDiff';

type EventStability = 'stable' | 'experimental';

const unknownRecordSchema = z.record(z.string(), z.unknown());
const stringArraySchema = z.array(z.string());

function typed<T>(schema: z.ZodType): z.ZodType<T> {
  return schema as z.ZodType<T>;
}

const toolResultSchema = typed<ToolResult>(z.object({
  toolCallId: z.string(),
  success: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
  outputPath: z.string().optional(),
  duration: z.number().optional(),
  metadata: unknownRecordSchema.optional(),
}));

const toolCallSchema: z.ZodType<ToolCall> = typed<ToolCall>(z.object({
  id: z.string(),
  name: z.string(),
  arguments: unknownRecordSchema,
  result: z.lazy(() => toolResultSchema).optional(),
  liveOutput: z.object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    truncated: z.boolean().optional(),
    updatedAt: z.number().optional(),
  }).optional(),
  _streaming: z.boolean().optional(),
  _argumentsRaw: z.string().optional(),
  shortDescription: z.string().optional(),
  stepLabel: z.enum([
    'tmeetMeetingListUpcoming',
    'tmeetMeetingListEnded',
    'tmeetMeetingCreate',
    'tmeetMeetingSearch',
  ]).optional(),
  targetContext: z.object({
    kind: z.enum(['app', 'browser', 'mcp_server', 'file', 'memory']).optional(),
    label: z.string().optional(),
    iconHint: z.string().optional(),
  }).optional(),
  expectedOutcome: z.string().optional(),
}));

const messageSchema = typed<Message>(z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  timestamp: z.number(),
  visibility: z.enum(['active', 'rewound']).optional(),
  hiddenByRewindId: z.string().optional(),
  hiddenAt: z.number().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
  toolResults: z.array(toolResultSchema).optional(),
  contentParts: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('tool_call'), toolCallId: z.string() }),
  ])).optional(),
  attachments: z.array(z.object({
    id: z.string(),
    type: z.enum(['image', 'file']),
    category: z.enum(['image', 'audio', 'video', 'pdf', 'excel', 'presentation', 'archive', 'code', 'text', 'data', 'document', 'html', 'folder', 'other']),
    name: z.string(),
    size: z.number(),
    mimeType: z.string(),
  }).loose()).optional(),
  isMeta: z.boolean().optional(),
  source: z.enum(['user', 'skill', 'system', 'goal', 'model', 'automation']).optional(),
  reasoning: z.string().optional(),
  parentToolUseId: z.string().optional(),
  subtype: z.enum(['init', 'result', 'thinking', 'tool_use']).optional(),
  compaction: z.object({
    type: z.literal('compaction'),
    content: z.string(),
    timestamp: z.number(),
    compactedMessageCount: z.number(),
    compactedTokenCount: z.number(),
  }).loose().optional(),
  thinking: z.string().optional(),
  responsesOutput: z.array(z.unknown()).optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra_code']).optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  modelDecision: unknownRecordSchema.optional(),
  artifacts: z.array(z.object({
    id: z.string(),
    type: z.enum(['chart', 'spreadsheet', 'document', 'generative_ui', 'neo_ui', 'mermaid', 'question_form']),
    title: z.string().optional(),
    content: z.string(),
    version: z.number(),
    parentId: z.string().optional(),
  })).optional(),
  metadata: unknownRecordSchema.optional(),
  cache_control: z.object({ type: z.literal('ephemeral') }).optional(),
}));

const permissionRequestSchema = typed<PermissionRequest>(z.object({
  id: z.string(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  parentToolUseId: z.string().optional(),
  forceConfirm: z.boolean().optional(),
  type: z.enum(['file_read', 'file_write', 'file_edit', 'file_delete', 'command', 'dangerous_command', 'network', 'mcp', 'directory_access']),
  tool: z.string(),
  details: z.object({
    path: z.string().optional(),
    filePath: z.string().optional(),
    command: z.string().optional(),
    url: z.string().optional(),
    changes: z.string().optional(),
    oldContent: z.string().optional(),
    newContent: z.string().optional(),
    server: z.string().optional(),
    toolName: z.string().optional(),
    commandRiskLevel: z.enum(['safe', 'unknown', 'low', 'medium', 'high', 'critical']).optional(),
    commandSecurityFlags: z.array(z.string()).optional(),
    affectedPath: z.string().optional(),
    affectedFileCount: z.number().int().nonnegative().optional(),
    standingGrantTarget: z.string().optional(),
    requestedAccess: z.enum(['read_only', 'read_write']).optional(),
    preview: z.object({
      type: z.enum(['diff', 'command', 'network', 'generic']),
      before: z.string().optional(),
      after: z.string().optional(),
      diff: z.string().optional(),
      summary: z.string(),
    }).optional(),
  }),
  reason: z.string().optional(),
  reasonCode: z.string().optional(),
  boundary: unknownRecordSchema.optional(),
  timestamp: z.number(),
  resolved: z.boolean().optional(),
  decision: z.enum(['once', 'deny', 'session', 'always', 'never', 'timeout']).optional(),
  dangerLevel: z.enum(['normal', 'warning', 'danger']).optional(),
  decisionTrace: unknownRecordSchema.optional(),
}));

const todoItemSchema = typed<TodoItem>(z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string(),
}));

const evidenceRefSchema = typed<EvidenceRef>(z.object({
  id: z.string(),
  kind: z.enum(['read', 'file', 'diff', 'patch', 'tool', 'test', 'typecheck', 'build', 'ci', 'browser_dom', 'browser_a11y', 'screenshot', 'computer_ax', 'artifact', 'trace']),
  ref: z.string(),
  source: z.string(),
  freshness: z.object({
    capturedAtMs: z.number(),
    digest: z.string().optional(),
    state: z.enum(['fresh', 'candidate', 'read', 'stale', 'needs_re_read', 'not_run']),
  }),
  redactionStatus: z.enum(['clean', 'redacted', 'contains_secret_blocked']),
}));

const sessionTaskSchema = typed<SessionTask>(z.object({
  id: z.string(),
  subject: z.string(),
  description: z.string(),
  activeForm: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked', 'cancelled']),
  priority: z.enum(['low', 'normal', 'high']),
  blocks: stringArraySchema,
  blockedBy: stringArraySchema,
  parentTaskId: z.string().optional(),
  blockedReason: z.string().optional(),
  blockedReasonCategory: z.enum(['network', 'rate_limit', 'permission', 'resource', 'tool', 'model', 'logic', 'handback', 'unknown']).optional(),
  owner: z.string().optional(),
  evidenceRefs: z.array(evidenceRefSchema).optional(),
  metadata: unknownRecordSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
}));

const taskUpdateSchema = typed<TaskUpdateEventData>(z.object({
  tasks: z.array(sessionTaskSchema),
  action: z.enum(['create', 'update', 'delete', 'sync']),
  taskId: z.string().optional(),
  taskIds: stringArraySchema.optional(),
  source: z.string().optional(),
}));

const messageDeltaSchema = typed<MessageDeltaData>(z.object({
  role: z.literal('assistant'),
  path: z.enum(['content', 'reasoning']),
  op: z.enum(['append', 'replace']),
  text: z.string(),
  turnId: z.string().optional(),
  messageId: z.string().optional(),
  deltaSeq: z.number().optional(),
  parentToolUseId: z.string().optional(),
}));

const messageSnapshotSchema = typed<MessageSnapshotData>(z.object({
  role: z.literal('assistant'),
  turnId: z.string().optional(),
  messageId: z.string().optional(),
  content: z.string(),
  reasoning: z.string().optional(),
  isFinal: z.boolean().optional(),
  source: z.literal('main_accumulator'),
}));

const modelProviderIdentitySchema = typed<ModelProviderIdentity>(z.object({
  provider: z.string(),
  displayName: z.string().optional(),
  sourceLabel: z.string().optional(),
  protocol: z.string().optional(),
  transportLabel: z.string().optional(),
  endpoint: z.string().optional(),
}));

const modelFallbackTraceStepSchema = typed<ModelFallbackTraceStep>(z.object({
  provider: z.string(),
  model: z.string().optional(),
  providerIdentity: modelProviderIdentitySchema.optional(),
  status: z.enum(['tried', 'skipped', 'selected', 'exhausted']),
  reason: z.string(),
  category: z.string().optional(),
  detail: z.string().optional(),
}));

const modelFallbackToolPolicySchema = typed<ModelFallbackToolPolicy>(z.object({
  status: z.literal('disabled'),
  reason: z.literal('fallback_model_without_tool_support'),
  originalToolCount: z.number(),
  effectiveToolCount: z.number(),
  disabledToolNames: stringArraySchema.optional(),
  detail: z.string().optional(),
}));

const modelFallbackStrategySchema = typed<ModelFallbackStrategy>(z.enum([
  'adaptive-provider-fallback',
  'adaptive-capability-fallback',
  'adaptive-main-task-recovery',
]));

const modelFallbackInfoSchema = typed<ModelFallbackInfo>(z.object({
  from: z.object({ provider: z.string(), model: z.string().optional() }),
  to: z.object({ provider: z.string(), model: z.string().optional() }),
  fromIdentity: modelProviderIdentitySchema.optional(),
  toIdentity: modelProviderIdentitySchema.optional(),
  reason: z.string(),
  category: z.string(),
  strategy: modelFallbackStrategySchema.optional(),
  tried: z.array(modelFallbackTraceStepSchema).optional(),
  skipped: z.array(modelFallbackTraceStepSchema).optional(),
  toolPolicy: modelFallbackToolPolicySchema.optional(),
}));

const modelToolStrategyDiagnosticsSchema = typed<ModelToolStrategyDiagnostics>(z.object({
  visibleToolCount: z.number(),
  toolNamesPreview: stringArraySchema.optional(),
  mcpToolCount: z.number(),
  mcpServerIds: stringArraySchema.optional(),
  programmaticToolCalling: z.enum(['available', 'unavailable']),
  programmaticToolCount: z.number(),
  tokenSavings: unknownRecordSchema.optional(),
}));

const modelDecisionSchema = typed<ModelDecisionEventData>(z.object({
  requestedProvider: z.string(),
  requestedModel: z.string(),
  resolvedProvider: z.string(),
  resolvedModel: z.string(),
  role: z.string().nullable(),
  reason: z.enum(['user-selected', 'default-model', 'role-tier', 'simple-task-free', 'billing-gate-skip', 'strategy-fast', 'strategy-main', 'strategy-deep', 'strategy-vision', 'capability-vision', 'fallback-availability']),
  billingMode: z.enum(['free', 'plan', 'payg', 'unknown']),
  fallbackFrom: z.string().nullable(),
  turnId: z.string().optional(),
  timestamp: z.number().optional(),
}).loose());

const surfaceExecutionSchema = typed<SurfaceExecutionEventV1>(z.object({
  version: z.literal(1),
  eventId: z.string(),
  sequence: z.number(),
  sessionId: z.string(),
  conversationId: z.string().optional(),
  runId: z.string(),
  turnId: z.string().optional(),
  agentId: z.string(),
  surface: z.enum(['browser', 'computer']),
  provider: z.string().optional(),
  sessionState: z.enum(['preparing', 'waiting_permission', 'running', 'waiting_human', 'paused', 'stopping', 'completed', 'failed']).optional(),
  heartbeatAt: z.number().optional(),
  phase: z.enum(['prepare', 'observe', 'act', 'verify', 'human', 'recover', 'artifact', 'cleanup']),
  status: z.enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'ambiguous', 'cancelled']),
  userSummary: z.string(),
  target: unknownRecordSchema.optional(),
  operation: z.object({
    action: z.string(),
    risk: z.string(),
    approvalScope: z.string().optional(),
    expectedOutcome: z.string().optional(),
  }).optional(),
  observation: z.object({
    verdict: z.enum(['pass', 'partial', 'fail', 'inconclusive', 'not_requested']),
    findings: stringArraySchema,
    confidence: z.number().optional(),
  }).optional(),
  evidenceRefs: stringArraySchema,
  evidence: z.array(unknownRecordSchema).optional(),
  artifactRefs: stringArraySchema,
  availableControls: z.array(z.enum(['pause', 'resume', 'continue', 'takeover', 'skip', 'stop', 'end_session'])),
  startedAt: z.number(),
  completedAt: z.number().optional(),
}));

const goalSkippedCheckSchema = typed<GoalGateSkippedCheck>(z.object({
  id: z.string(),
  kind: z.string(),
  reason: z.string(),
  files: stringArraySchema.optional(),
}));

const goalPlannedCommandSchema = typed<GoalGatePlannedCommand>(z.object({
  id: z.string(),
  command: z.string(),
  cwd: z.string(),
  required: z.boolean(),
  kind: z.string(),
  reason: z.string(),
  source: z.string(),
  timeoutMs: z.number().optional(),
}));

const goalVerificationCardSchema = typed<GoalGateVerificationCard>(z.object({
  status: z.enum(['passed', 'failed', 'not_run']),
  failureType: z.enum(['test', 'lint', 'typecheck', 'build', 'env_missing', 'dependency_missing', 'timeout', 'unverifiable']).optional(),
  summary: z.string(),
  counts: z.object({ passed: z.number(), failed: z.number(), notRun: z.number(), total: z.number() }),
  requiredStatus: z.enum(['passed', 'failed', 'not_run']),
  commands: z.array(z.object({
    id: z.string(),
    command: z.string(),
    required: z.boolean(),
    kind: z.string(),
    reason: z.string(),
    pass: z.boolean(),
    exitCode: z.number().nullable().optional(),
    durationMs: z.number().optional(),
    timedOut: z.boolean().optional(),
    stdoutTail: z.string().optional(),
    stderrTail: z.string().optional(),
    outputTail: z.string().optional(),
    evidenceRefId: z.string().optional(),
  })),
  evidenceRefIds: stringArraySchema,
  skippedChecks: z.array(goalSkippedCheckSchema),
}));

const citationSchema = typed<Citation>(z.object({
  id: z.string(),
  type: z.enum(['file', 'url', 'cell', 'query', 'memory']),
  source: z.string(),
  location: z.string().optional(),
  label: z.string(),
  toolCallId: z.string(),
  timestamp: z.number(),
  rationale: z.string().optional(),
  lineRange: z.tuple([z.number(), z.number()]).optional(),
}));

const stabilityByType = {
  message: 'stable',
  surface_execution: 'experimental',
  tool_call_start: 'stable',
  tool_call_end: 'stable',
  artifact_write_started: 'stable',
  permission_request: 'stable',
  model_decision: 'experimental',
  hook_trigger: 'experimental',
  hook_started: 'experimental',
  error: 'stable',
  message_delta: 'experimental',
  message_snapshot: 'experimental',
  stream_chunk: 'experimental',
  stream_reasoning: 'experimental',
  stream_tool_call_start: 'experimental',
  stream_tool_call_delta: 'experimental',
  todo_update: 'experimental',
  task_update: 'experimental',
  turn_diff: 'experimental',
  notification: 'experimental',
  routing_resolved: 'experimental',
  artifact_locator: 'stable',
  agent_complete: 'stable',
  agent_cancelled: 'stable',
  goal_iteration: 'experimental',
  goal_gate: 'experimental',
  goal_complete: 'experimental',
  agent_thinking: 'experimental',
  turn_start: 'stable',
  turn_end: 'stable',
  subagent_activity: 'experimental',
  subagent_run_end: 'experimental',
  skill_activated: 'experimental',
  memory_injected: 'experimental',
  tool_schema_snapshot: 'experimental',
  model_response: 'experimental',
  model_fallback: 'experimental',
  api_key_required: 'experimental',
  task_progress: 'experimental',
  task_complete: 'experimental',
  background_task_ledger_changed: 'experimental',
  memory_learned: 'experimental',
  skill_draft_pending: 'experimental',
  role_draft_pending: 'experimental',
  team_recipe_draft_pending: 'experimental',
  research_mode_started: 'experimental',
  research_progress: 'experimental',
  research_complete: 'experimental',
  research_error: 'experimental',
  research_detected: 'experimental',
  budget_warning: 'experimental',
  budget_exceeded: 'experimental',
  context_compressed: 'experimental',
  interrupt_start: 'experimental',
  interrupt_acknowledged: 'experimental',
  interrupt_complete: 'experimental',
  input_redirected: 'experimental',
  citations_updated: 'experimental',
  model_switched: 'experimental',
  tool_progress: 'experimental',
  tool_output_delta: 'experimental',
  tool_timeout: 'experimental',
  plan_mode_entered: 'experimental',
  plan_mode_exited: 'experimental',
  task_stats: 'experimental',
  context_compacting: 'experimental',
  context_compacted: 'experimental',
  stream_usage: 'stable',
  stream_token_estimate: 'experimental',
  tool_call_local: 'experimental',
  tool_cancel_local: 'experimental',
  suggestions_update: 'experimental',
} as const satisfies Record<string, EventStability>;

function event<T extends keyof typeof stabilityByType, S extends z.ZodType>(type: T, data: S) {
  const stability = stabilityByType[type];
  return z.object({ type: z.literal(type), data }).meta({
    stability,
    description: stability === 'stable'
      ? 'Stable event. Its shape is additive-only: fields may be added, but existing fields are not changed or removed.'
      : 'Experimental event. Its shape may change or be removed.',
  });
}

const MessageEventSchema = event('message', messageSchema);
const SurfaceExecutionEventSchema = event('surface_execution', surfaceExecutionSchema);
const ToolCallStartEventSchema = event('tool_call_start', typed<ToolCall & { _index?: number; turnId?: string; parentToolUseId?: string; agentId?: string; runId?: string }>(toolCallSchema.and(z.object({ _index: z.number().optional(), turnId: z.string().optional(), parentToolUseId: z.string().optional(), agentId: z.string().optional(), runId: z.string().optional() }))));
const ToolCallEndEventSchema = event('tool_call_end', typed<ToolResult & { parentToolUseId?: string; agentId?: string; runId?: string }>(toolResultSchema.and(z.object({ parentToolUseId: z.string().optional(), agentId: z.string().optional(), runId: z.string().optional() }))));
const ArtifactWriteStartedEventSchema = event('artifact_write_started', typed<ArtifactWriteStartedData>(z.object({ toolCallId: z.string(), toolName: z.string(), filePath: z.string() })));
const PermissionRequestEventSchema = event('permission_request', permissionRequestSchema);
const ModelDecisionEventSchema = event('model_decision', modelDecisionSchema);
const HookTriggerEventSchema = event('hook_trigger', typed<HookTriggerEventData>(z.object({
  timestamp: z.number(), event: z.string(), action: z.enum(['allow', 'block']), durationMs: z.number(), hookCount: z.number(), modified: z.boolean(),
  sources: z.array(z.enum(['global', 'project'])), hookType: z.enum(['decision', 'observer']), names: stringArraySchema.optional(), errorCount: z.number().optional(),
  message: z.string().optional(), reason: z.string().optional(), sessionId: z.string().optional(), turnId: z.string().optional(), toolName: z.string().optional(), matcher: z.string().optional(),
})));
const HookStartedEventSchema = event('hook_started', typed<HookStartedEventData>(z.object({
  timestamp: z.number(), event: z.string(), names: stringArraySchema.optional(), sessionId: z.string().optional(), turnId: z.string().optional(), toolName: z.string().optional(), matcher: z.string().optional(),
})));
const ErrorEventSchema = event('error', z.object({ message: z.string(), code: z.string().optional(), suggestion: z.string().optional(), details: unknownRecordSchema.optional(), goalAbort: z.boolean().optional(), parentToolUseId: z.string().optional() }));
const MessageDeltaEventSchema = event('message_delta', messageDeltaSchema);
const MessageSnapshotEventSchema = event('message_snapshot', messageSnapshotSchema);
const StreamChunkEventSchema = event('stream_chunk', typed<{ content: string | undefined; turnId?: string; parentToolUseId?: string }>(z.object({ content: z.string().optional(), turnId: z.string().optional(), parentToolUseId: z.string().optional() })));
const StreamReasoningEventSchema = event('stream_reasoning', typed<{ content: string | undefined; turnId?: string; parentToolUseId?: string }>(z.object({ content: z.string().optional(), turnId: z.string().optional(), parentToolUseId: z.string().optional() })));
const StreamToolCallStartEventSchema = event('stream_tool_call_start', z.object({ index: z.number().optional(), id: z.string().optional(), name: z.string().optional(), turnId: z.string().optional(), parentToolUseId: z.string().optional() }));
const StreamToolCallDeltaEventSchema = event('stream_tool_call_delta', z.object({ index: z.number().optional(), name: z.string().optional(), argumentsDelta: z.string().optional(), turnId: z.string().optional(), parentToolUseId: z.string().optional() }));
const TodoUpdateEventSchema = event('todo_update', z.array(todoItemSchema));
const TaskUpdateEventSchema = event('task_update', taskUpdateSchema);
const TurnDiffEventSchema = event('turn_diff', typed<TurnDiffEventData>(z.object({
  turnId: z.string(),
  files: z.array(z.object({
    filePath: z.string(),
    oldText: z.string(),
    newText: z.string(),
    added: z.number(),
    removed: z.number(),
    isNewFile: z.boolean(),
    editCount: z.number(),
  })),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  parentToolUseId: z.string().optional(),
})));
const NotificationEventSchema = event('notification', z.object({ message: z.string(), parentToolUseId: z.string().optional() }));
const hostReasonPayloadSchema = typed<HostReasonPayload>(z.object({
  code: z.string(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  modelText: z.string(),
}));
const RoutingResolvedEventSchema = event('routing_resolved', typed<RoutingResolvedEventData>(z.object({ mode: z.enum(['auto', 'explicit']), agentId: z.string(), agentName: z.string(), reason: z.union([z.string(), hostReasonPayloadSchema]), score: z.number(), fallbackToDefault: z.boolean().optional(), requestedAgentId: z.string().optional(), timestamp: z.number().optional() })));
const ArtifactLocatorEventSchema = event('artifact_locator', typed<ArtifactLocatorTelemetryEventData>(z.object({ state: z.enum(['resolved', 'stale', 'blocked']), kind: z.enum(['spreadsheet', 'presentation', 'document']), reason: z.string() })));
const AgentCompleteEventSchema = event('agent_complete', z.null());
const AgentCancelledEventSchema = event('agent_cancelled', z.null());
const GoalIterationEventSchema = event('goal_iteration', z.object({ turn: z.number(), maxTurns: z.number(), goalStatus: z.enum(['pending', 'paused', 'met', 'aborted']), pauseReason: z.enum(['anti_spin']).optional(), tokensUsed: z.number(), tokenBudget: z.number(), wallClockBudgetMs: z.number().optional(), parentToolUseId: z.string().optional() }));
const GoalGateEventSchema = event('goal_gate', z.object({
  gate: z.number(), pass: z.boolean(), exitCode: z.number().nullable().optional(), timedOut: z.boolean().optional(), reason: z.string().optional(), parentToolUseId: z.string().optional(),
  verdict: z.enum(['allow_finalize', 'repair_prompt', 'exhausted_release']).optional(), attempt: z.number().optional(), verificationStatus: z.enum(['passed', 'failed', 'not_run']).optional(),
  failureType: z.enum(['test', 'lint', 'typecheck', 'build', 'env_missing', 'dependency_missing', 'timeout', 'unverifiable']).optional(), evidenceRefs: z.array(evidenceRefSchema).optional(),
  skippedChecks: z.array(goalSkippedCheckSchema).optional(), plannedOptionalCommands: z.array(goalPlannedCommandSchema).optional(), verificationCard: goalVerificationCardSchema.optional(),
}));
const GoalCompleteEventSchema = event('goal_complete', z.object({ status: z.enum(['met', 'aborted']), reason: z.union([z.string(), hostReasonPayloadSchema]).optional(), turns: z.number(), tokensUsed: z.number(), degraded: z.boolean().optional(), degradedReason: z.string().optional(), parentToolUseId: z.string().optional() }));
const AgentThinkingEventSchema = event('agent_thinking', z.object({ message: z.string(), agentId: z.string().optional(), progress: z.number().optional(), parentToolUseId: z.string().optional() }));
const TurnStartEventSchema = event('turn_start', z.object({ turnId: z.string(), iteration: z.number().optional(), parentToolUseId: z.string().optional(), agentId: z.string().optional(), runId: z.string().optional() }));
const TurnEndEventSchema = event('turn_end', z.object({ turnId: z.string(), parentToolUseId: z.string().optional(), agentId: z.string().optional(), runId: z.string().optional() }));
const SubagentActivityEventSchema = event('subagent_activity', z.object({
  agentId: z.string(),
  runId: z.string(),
  parentToolUseId: z.string().optional(),
  kind: z.enum(['started']),
}));
const SubagentRunEndEventSchema = event('subagent_run_end', z.object({
  agentId: z.string(),
  runId: z.string(),
  parentToolUseId: z.string().optional(),
  status: z.enum(['completed', 'cancelled', 'failed']),
  error: z.string().optional(),
}));
const SkillActivatedEventSchema = event('skill_activated', z.object({ name: z.string() }));
const MemoryInjectedEventSchema = event('memory_injected', z.object({ id: z.string() }));
const ToolSchemaSnapshotEventSchema = event('tool_schema_snapshot', z.object({
  turnId: z.string().optional(), toolCount: z.number(), tools: z.array(z.object({ name: z.string(), inputSchema: unknownRecordSchema.optional(), requiresPermission: z.boolean().optional(), permissionLevel: z.string().optional() })), parentToolUseId: z.string().optional(),
}));
const ModelResponseEventSchema = event('model_response', z.object({
  model: z.string(), provider: z.string().optional(), responseType: z.string(), duration: z.number(), toolCalls: stringArraySchema, textLength: z.number(), inputTokens: z.number().optional(), outputTokens: z.number().optional(),
  requestedModel: z.string().optional(), requestedProvider: z.string().optional(), fallback: modelFallbackInfoSchema.optional(),
  runtimeDiagnostics: z.object({
    visibleToolNames: stringArraySchema.optional(), toolStrategy: modelToolStrategyDiagnosticsSchema.optional(), modelDecision: modelDecisionSchema.optional(),
    artifactRepairGuard: z.object({ targetFile: z.string().optional(), attempts: z.number().optional(), phase: z.string().optional(), patched: z.boolean().optional(), noProgressTurns: z.number().optional(), activeIssueCodes: stringArraySchema.optional() }).optional(),
    maxMode: z.object({ candidates: z.number(), survivors: z.number(), winner: z.number(), degraded: z.boolean(), judgeParsed: z.boolean(), overheadInputTokens: z.number(), overheadOutputTokens: z.number() }).optional(),
  }).optional(),
}));
const ModelFallbackEventSchema = event('model_fallback', z.object({
  reason: z.string(), from: z.string(), to: z.string(), category: z.string().optional(), strategy: modelFallbackStrategySchema.optional(), tried: z.array(modelFallbackTraceStepSchema).optional(), skipped: z.array(modelFallbackTraceStepSchema).optional(), toolPolicy: modelFallbackToolPolicySchema.optional(), fromIdentity: modelProviderIdentitySchema.optional(), toIdentity: modelProviderIdentitySchema.optional(), turnId: z.string().optional(),
}));
const ApiKeyRequiredEventSchema = event('api_key_required', z.object({ provider: z.string(), capability: z.string(), message: z.string() }));
const TaskProgressEventSchema = event('task_progress', typed<TaskProgressData & { parentToolUseId?: string }>(z.object({ turnId: z.string(), phase: z.enum(['thinking', 'tool_pending', 'tool_running', 'generating', 'completed', 'failed']), step: z.string().optional(), progress: z.number().optional(), tool: z.string().optional(), toolIndex: z.number().optional(), toolTotal: z.number().optional(), parentToolUseId: z.string().optional() })));
const TaskCompleteEventSchema = event('task_complete', typed<TaskCompleteData & { parentToolUseId?: string }>(z.object({ turnId: z.string(), summary: z.string().optional(), duration: z.number(), toolsUsed: stringArraySchema, parentToolUseId: z.string().optional() })));
const BackgroundTaskLedgerChangedEventSchema = event('background_task_ledger_changed', typed<BackgroundTaskLedgerChangedData>(z.object({ taskId: z.string(), sessionId: z.string().optional() })));
const MemoryLearnedEventSchema = event('memory_learned', typed<MemoryLearnedData>(z.object({ sessionId: z.string(), knowledgeExtracted: z.number(), codeStylesLearned: z.number(), toolPreferencesUpdated: z.number() })));
const SkillDraftPendingEventSchema = event('skill_draft_pending', typed<SkillDraftPendingData>(z.object({ sessionId: z.string(), drafts: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), toolSequence: stringArraySchema, occurrences: z.number(), origin: z.enum(['telemetry-distilled', 'llm-review']) })) })));
const RoleDraftPendingEventSchema = event('role_draft_pending', typed<RoleDraftPendingData>(z.object({ sessionId: z.string(), drafts: z.array(z.object({ id: z.string(), roleId: z.string(), description: z.string(), category: z.string().optional(), tools: stringArraySchema, editingRoleId: z.string().optional() })) })));
const TeamRecipeDraftPendingEventSchema = event('team_recipe_draft_pending', typed<TeamRecipeDraftPendingData>(z.object({ sessionId: z.string(), drafts: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), lead: z.object({ roleId: z.string(), briefTemplate: z.string() }).optional(), members: z.array(z.object({ id: z.string().optional(), roleId: z.string(), taskTemplate: z.string() })), unknownRoleNames: stringArraySchema.optional() })) })));
const ResearchModeStartedEventSchema = event('research_mode_started', typed<ResearchModeStartedData>(z.object({ topic: z.string(), reportStyle: z.enum(['default', 'academic', 'popular_science', 'news', 'social_media', 'strategic_investment']), triggeredBy: z.enum(['semantic', 'manual']).optional() })));
const ResearchProgressEventSchema = event('research_progress', typed<ResearchProgressData>(z.object({ phase: z.enum(['planning', 'researching', 'reporting', 'complete', 'error']), message: z.string(), percent: z.number(), currentStep: z.object({ title: z.string(), status: z.enum(['running', 'completed', 'failed']) }).optional(), triggeredBy: z.enum(['semantic', 'manual']).optional(), currentIteration: z.number().optional(), maxIterations: z.number().optional(), coverage: z.number().optional(), activeSources: stringArraySchema.optional(), canDeepen: z.boolean().optional() })));
const ResearchCompleteEventSchema = event('research_complete', typed<ResearchCompleteData>(z.object({ success: z.boolean(), report: z.object({ title: z.string(), content: z.string(), sources: z.array(z.object({ title: z.string(), url: z.string() })) }).optional() })));
const ResearchErrorEventSchema = event('research_error', typed<ResearchErrorData>(z.object({ error: z.string() })));
const ResearchDetectedEventSchema = event('research_detected', typed<ResearchDetectedData>(z.object({ intent: z.string(), confidence: z.number(), suggestedDepth: z.enum(['quick', 'standard', 'deep']), reasoning: z.string() })));
const BudgetWarningEventSchema = event('budget_warning', typed<BudgetEventData>(z.object({ currentCost: z.number(), maxBudget: z.number(), usagePercentage: z.number(), remaining: z.number(), alertLevel: z.enum(['silent', 'warning', 'blocked']), message: z.string().optional() })));
const BudgetExceededEventSchema = event('budget_exceeded', typed<BudgetEventData>(z.object({ currentCost: z.number(), maxBudget: z.number(), usagePercentage: z.number(), remaining: z.number(), alertLevel: z.enum(['silent', 'warning', 'blocked']), message: z.string().optional() })));
const ContextCompressedEventSchema = event('context_compressed', typed<ContextCompressedData>(z.object({ savedTokens: z.number(), strategy: z.string().optional(), newMessageCount: z.number() })));
const interruptSchema = typed<InterruptEventData>(z.object({ message: z.string(), newUserMessage: z.string().optional() }));
const InterruptStartEventSchema = event('interrupt_start', interruptSchema);
const InterruptAcknowledgedEventSchema = event('interrupt_acknowledged', interruptSchema);
const InterruptCompleteEventSchema = event('interrupt_complete', interruptSchema);
const InputRedirectedEventSchema = event('input_redirected', z.object({
  receiptId: z.string(),
  originalContent: z.string(),
  expectedTurnId: z.string().optional(),
  partial: z.object({
    charCount: z.number().int().nonnegative(),
    trailingText: z.string().optional(),
  }),
  interruptedTools: stringArraySchema,
}));
const CitationsUpdatedEventSchema = event('citations_updated', z.object({ citations: z.array(citationSchema) }));
const ModelSwitchedEventSchema = event('model_switched', z.object({ from: z.string(), to: z.string(), provider: z.string().optional() }));
const ToolProgressEventSchema = event('tool_progress', typed<ToolProgressData>(z.object({ toolCallId: z.string(), toolName: z.string(), elapsedMs: z.number(), detail: z.string().optional() })));
const ToolOutputDeltaEventSchema = event('tool_output_delta', typed<ToolOutputDeltaData>(z.object({ toolCallId: z.string(), toolName: z.string(), stream: z.enum(['stdout', 'stderr']), content: z.string(), elapsedMs: z.number().optional(), truncated: z.boolean().optional() })));
const ToolTimeoutEventSchema = event('tool_timeout', typed<ToolTimeoutData>(z.object({ toolCallId: z.string(), toolName: z.string(), elapsedMs: z.number(), threshold: z.number() })));
const PlanModeEnteredEventSchema = event('plan_mode_entered', z.object({ reason: z.string() }));
const PlanModeExitedEventSchema = event('plan_mode_exited', z.object({ plan: z.string() }));
const TaskStatsEventSchema = event('task_stats', typed<TaskStatsData>(z.object({ elapsed_ms: z.number(), iterations: z.number(), tokensUsed: z.number(), contextUsage: z.number(), toolCallCount: z.number(), contextWindow: z.number() })));
const ContextCompactingEventSchema = event('context_compacting', z.object({ tokensBefore: z.number(), messagesCount: z.number() }));
const ContextCompactedEventSchema = event('context_compacted', z.object({ tokensBefore: z.number(), tokensAfter: z.number(), messagesRemoved: z.number(), duration_ms: z.number() }));
const StreamUsageEventSchema = event('stream_usage', z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number().optional(), cacheCreationTokens: z.number().optional(), turnId: z.string().optional() }));
const StreamTokenEstimateEventSchema = event('stream_token_estimate', z.object({ inputTokens: z.number(), outputTokens: z.number(), turnId: z.string().optional() }));
const ToolCallLocalEventSchema = event('tool_call_local', typed<LocalToolCallData>(z.object({ toolCallId: z.string(), tool: z.string(), originalTool: z.string().optional(), params: unknownRecordSchema, permissionLevel: z.enum(['L1', 'L2', 'L3']), runId: z.string(), sessionId: z.string(), workspace: z.string(), cwd: z.string() })));
const ToolCancelLocalEventSchema = event('tool_cancel_local', typed<LocalToolCancelData>(z.object({ toolCallId: z.string(), runId: z.string(), sessionId: z.string() })));
const SuggestionsUpdateEventSchema = event('suggestions_update', z.array(z.object({ id: z.string(), text: z.string(), source: z.string() })));

export const AgentEventSchema = z.discriminatedUnion('type', [
  MessageEventSchema, SurfaceExecutionEventSchema, ToolCallStartEventSchema, ToolCallEndEventSchema,
  ArtifactWriteStartedEventSchema, PermissionRequestEventSchema, ModelDecisionEventSchema, HookTriggerEventSchema,
  HookStartedEventSchema, ErrorEventSchema, MessageDeltaEventSchema, MessageSnapshotEventSchema, StreamChunkEventSchema,
  StreamReasoningEventSchema, StreamToolCallStartEventSchema, StreamToolCallDeltaEventSchema, TodoUpdateEventSchema,
  TaskUpdateEventSchema, TurnDiffEventSchema, NotificationEventSchema, RoutingResolvedEventSchema, ArtifactLocatorEventSchema,
  AgentCompleteEventSchema, AgentCancelledEventSchema, GoalIterationEventSchema, GoalGateEventSchema,
  GoalCompleteEventSchema, AgentThinkingEventSchema, TurnStartEventSchema, TurnEndEventSchema,
  SubagentActivityEventSchema, SubagentRunEndEventSchema, SkillActivatedEventSchema, MemoryInjectedEventSchema,
  ToolSchemaSnapshotEventSchema, ModelResponseEventSchema, ModelFallbackEventSchema, ApiKeyRequiredEventSchema,
  TaskProgressEventSchema, TaskCompleteEventSchema, BackgroundTaskLedgerChangedEventSchema, MemoryLearnedEventSchema,
  SkillDraftPendingEventSchema, RoleDraftPendingEventSchema, TeamRecipeDraftPendingEventSchema,
  ResearchModeStartedEventSchema, ResearchProgressEventSchema, ResearchCompleteEventSchema, ResearchErrorEventSchema,
  ResearchDetectedEventSchema, BudgetWarningEventSchema, BudgetExceededEventSchema, ContextCompressedEventSchema,
  InterruptStartEventSchema, InterruptAcknowledgedEventSchema, InterruptCompleteEventSchema, InputRedirectedEventSchema, CitationsUpdatedEventSchema,
  ModelSwitchedEventSchema, ToolProgressEventSchema, ToolOutputDeltaEventSchema, ToolTimeoutEventSchema,
  PlanModeEnteredEventSchema, PlanModeExitedEventSchema, TaskStatsEventSchema, ContextCompactingEventSchema,
  ContextCompactedEventSchema, StreamUsageEventSchema, StreamTokenEstimateEventSchema, ToolCallLocalEventSchema,
  ToolCancelLocalEventSchema, SuggestionsUpdateEventSchema,
]).meta({
  title: 'AgentEvent',
  description: 'Neo public agent event contract. New events default to experimental; stable event shapes are additive-only.',
});

type AgentEventFromSchema = z.infer<typeof AgentEventSchema>;

export const AgentEventEnvelopeSchema = AgentEventSchema.and(z.object({
  streamEpoch: z.string().min(1),
  sessionId: z.string().min(1),
  seq: z.number().int().positive(),
})).meta({
  title: 'AgentEventEnvelope',
  description: 'Self-contained AgentEvent envelope for transport, persistence, and replay.',
});

const stableEventTypeValues = Object.entries(stabilityByType)
  .filter(([, stability]) => stability === 'stable')
  .map(([type]) => type as AgentEventFromSchema['type']);

export const STABLE_EVENT_TYPES: ReadonlySet<AgentEventFromSchema['type']> = new Set(stableEventTypeValues);

// useAgentConversationStreamEffects - turn_start, message_delta, message_snapshot, stream_chunk, stream_reasoning, turn_end, message, model_decision, routing_resolved, hook_trigger
import { useEffect, useRef } from 'react';
import { generateMessageId } from '@shared/utils/id';
import type {
  BillingMode,
  AgentEngineCapability,
  AgentEngineFailureCategory,
  AgentEngineFailureDiagnostics,
  AgentEngineReliability,
  HookTriggerEventData,
  Message,
  ModelCapabilityNeed,
  ModelCostPolicy,
  ModelDecisionEventData,
  ModelDecisionReason,
  ModelExternalEngineSnapshot,
  ModelFallbackStrategy,
  ModelFallbackToolPolicy,
  ModelFallbackTraceStep,
  ModelProviderHealthSnapshot,
  ModelProviderHealthStatus,
  ModelProviderIdentity,
  ModelProviderProtocol,
  ModelSpeedPolicy,
  ModelTaskClass,
  ModelToolPolicy,
  ModelToolStrategyDiagnostics,
  ProgrammaticToolCallingStatus,
  ToolTokenSavingsStatus,
  ToolCall,
} from '@shared/contract';
import { createLogger } from '../../../utils/logger';
import { useSessionStore } from '../../../stores/sessionStore';
import { useTurnExecutionStore } from '../../../stores/turnExecutionStore';
import { useAppStore } from '../../../stores/appStore';
import { buildGoalNoticeMessage } from '../../../components/features/chat/goalNotice';
import { buildModelFallbackNoticeMessage } from '../../../components/features/chat/fallbackNotice';
import ipcService from '../../../services/ipcService';
import type { AgentEffectsProps } from '../useAgentEffects';
import { getAgentEventSessionId, isAgentEventForCurrentSession } from '../agentEventSession';

const logger = createLogger('useAgent');

type AgentEvent = { type: string; data?: unknown; sessionId?: string };

interface TurnIdPayload {
  turnId?: string;
  isMeta?: boolean;
}

interface StreamTextPayload extends TurnIdPayload {
  content: string;
}

interface MessageDeltaPayload extends TurnIdPayload {
  role: 'assistant';
  path: 'content' | 'reasoning';
  op: 'append' | 'replace';
  text: string;
  messageId?: string;
}

interface MessageSnapshotPayload extends TurnIdPayload {
  role: 'assistant';
  messageId?: string;
  content: string;
  reasoning?: string;
}

interface AssistantMessagePayload extends TurnIdPayload {
  id?: string;
  content?: string;
  reasoning?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  contentParts?: Message['contentParts'];
  artifacts?: Message['artifacts'];
  modelDecision?: ModelDecisionEventData;
}

interface RoutingResolvedPayload {
  mode: 'auto';
  timestamp?: number;
  agentId: string;
  agentName: string;
  reason: string;
  score: number;
  fallbackToDefault?: boolean;
}

interface ModelFallbackPayload {
  reason: string;
  from: string;
  to: string;
  category?: string;
  strategy?: ModelFallbackStrategy;
  tried?: ModelFallbackTraceStep[];
  skipped?: ModelFallbackTraceStep[];
  toolPolicy?: ModelFallbackToolPolicy;
  fromIdentity?: ModelProviderIdentity;
  toIdentity?: ModelProviderIdentity;
}

const MODEL_DECISION_REASONS = new Set<ModelDecisionReason>([
  'user-selected',
  'role-tier',
  'simple-task-free',
  'billing-gate-skip',
  'capability-vision',
  'fallback-availability',
]);

const BILLING_MODES = new Set<BillingMode>([
  'free',
  'plan',
  'payg',
  'unknown',
]);

const MODEL_TASK_CLASSES = new Set<ModelTaskClass>([
  'simple',
  'coding',
  'vision',
  'search',
  'artifact',
  'long-context',
  'multi-tool',
  'unknown',
]);

const MODEL_COST_POLICIES = new Set<ModelCostPolicy>([
  'save-cost',
  'plan-no-savings',
  'unknown-conservative',
  'user-locked',
  'neutral',
]);

const MODEL_SPEED_POLICIES = new Set<ModelSpeedPolicy>([
  'fast-path',
  'normal',
  'provider-degraded',
  'fallback-recovery',
]);

const MODEL_TOOL_POLICIES = new Set<ModelToolPolicy>([
  'runtime-checked',
  'disabled-by-model',
  'unknown',
]);

const PROGRAMMATIC_TOOL_CALLING_STATUSES = new Set<ProgrammaticToolCallingStatus>([
  'available',
  'unavailable',
]);

const TOOL_TOKEN_SAVINGS_STATUSES = new Set<ToolTokenSavingsStatus>([
  'not-measured',
  'estimated',
  'provider-reported',
]);

type NormalizedToolTokenSavingsMeasurementSource = 'tool-spec-local-estimate' | 'provider-reported' | 'not-measured';
type NormalizedToolTokenSavingsUsageSource = 'model-response-usage' | 'unavailable';

const TOOL_TOKEN_SAVINGS_MEASUREMENT_SOURCES = new Set<NormalizedToolTokenSavingsMeasurementSource>([
  'tool-spec-local-estimate',
  'provider-reported',
  'not-measured',
]);

const TOOL_TOKEN_SAVINGS_USAGE_SOURCES = new Set<NormalizedToolTokenSavingsUsageSource>([
  'model-response-usage',
  'unavailable',
]);

const MODEL_CAPABILITY_NEEDS = new Set<ModelCapabilityNeed>([
  'vision',
  'code',
  'search',
  'artifact',
  'long-context',
  'tool-use',
]);

const MODEL_PROVIDER_HEALTH_STATUSES = new Set<ModelProviderHealthStatus>([
  'healthy',
  'degraded',
  'unavailable',
  'recovering',
  'unknown',
]);

const MODEL_PROVIDER_PROTOCOLS = new Set<ModelProviderProtocol>([
  'openai',
  'claude',
]);

const EXTERNAL_AGENT_ENGINE_KINDS = new Set<ModelExternalEngineSnapshot['kind']>([
  'codex_cli',
  'claude_code',
]);

const AGENT_ENGINE_INSTALL_STATES = new Set<ModelExternalEngineSnapshot['installState']>([
  'builtin',
  'installed',
  'missing',
]);

const AGENT_ENGINE_RUNTIME_STATES = new Set<ModelExternalEngineSnapshot['runtimeState']>([
  'ready',
  'not_configured',
  'blocked',
  'error',
  'unknown',
]);

const AGENT_ENGINE_CAPABILITIES = new Set<AgentEngineCapability>([
  'execute',
  'stream_events',
  'import_sessions',
  'resume',
  'review',
]);

const AGENT_ENGINE_CLI_STATUSES = new Set<AgentEngineReliability['cliStatus']>([
  'available',
  'missing',
  'error',
  'not_checked',
]);

const AGENT_ENGINE_AUTH_STATES = new Set<AgentEngineReliability['authState']>([
  'authenticated',
  'needs_login',
  'not_checked',
  'unknown',
]);

const AGENT_ENGINE_QUOTA_STATES = new Set<AgentEngineReliability['quotaState']>([
  'available',
  'limited',
  'exhausted',
  'not_checked',
  'unknown',
]);

const AGENT_ENGINE_STREAMING_MODES = new Set<AgentEngineReliability['streamingMode']>([
  'stream_json',
  'json',
  'text',
  'none',
  'unknown',
]);

const AGENT_ENGINE_TOOL_SUPPORT = new Set<AgentEngineReliability['toolSupport']>([
  'none',
  'read_only_cli_tools',
  'workspace_tools',
  'mcp_bridge',
  'unknown',
]);

const AGENT_ENGINE_TRANSCRIPT_MODES = new Set<AgentEngineReliability['transcriptMode']>([
  'clean_stream_json',
  'raw_terminal',
  'session_import',
  'unknown',
]);

const AGENT_ENGINE_FAILURE_CATEGORIES = new Set<AgentEngineFailureCategory>([
  'auth',
  'quota',
  'timeout',
  'network',
  'permission',
  'missing_cli',
  'runtime',
  'unknown',
]);

const MODEL_FALLBACK_TRACE_STATUSES = new Set<ModelFallbackTraceStep['status']>([
  'tried',
  'skipped',
  'selected',
  'exhausted',
]);

const MODEL_FALLBACK_STRATEGIES = new Set<ModelFallbackStrategy>([
  'adaptive-provider-fallback',
  'adaptive-capability-fallback',
  'adaptive-main-task-recovery',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

function getNumberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
}

function getBooleanField(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === 'boolean' ? value : undefined;
}

function getEnumField<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<T>,
): T | undefined {
  const value = getStringField(record, field);
  return value && allowed.has(value as T) ? value as T : undefined;
}

function getEnumArrayField<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<T>,
): T[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((item): item is T => typeof item === 'string' && allowed.has(item as T));
  return entries.length > 0 ? entries : undefined;
}

function normalizeProviderHealthSnapshot(value: unknown): ModelProviderHealthSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const provider = getStringField(value, 'provider');
  const status = getEnumField(value, 'status', MODEL_PROVIDER_HEALTH_STATUSES);
  const sampledAt = getNumberField(value, 'sampledAt');
  if (!provider || !status || sampledAt === undefined) return undefined;

  const latencyP50 = getNumberField(value, 'latencyP50');
  const latencyP95 = getNumberField(value, 'latencyP95');
  const errorRate = getNumberField(value, 'errorRate');
  const lastSuccessAt = getNumberField(value, 'lastSuccessAt');
  const lastErrorAt = getNumberField(value, 'lastErrorAt');
  const consecutiveErrors = getNumberField(value, 'consecutiveErrors');

  return {
    provider,
    status,
    sampledAt,
    ...(latencyP50 !== undefined ? { latencyP50 } : {}),
    ...(latencyP95 !== undefined ? { latencyP95 } : {}),
	    ...(errorRate !== undefined ? { errorRate } : {}),
	    ...(lastSuccessAt !== undefined ? { lastSuccessAt } : {}),
	    ...(lastErrorAt !== undefined ? { lastErrorAt } : {}),
	    ...(consecutiveErrors !== undefined ? { consecutiveErrors } : {}),
  };
}

function normalizeModelProviderIdentity(value: unknown): ModelProviderIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const provider = getStringField(value, 'provider');
  if (!provider) return undefined;

  const displayName = getStringField(value, 'displayName');
  const sourceLabel = getStringField(value, 'sourceLabel');
  const protocol = getEnumField(value, 'protocol', MODEL_PROVIDER_PROTOCOLS);
  const transportLabel = getStringField(value, 'transportLabel');
  const endpoint = getStringField(value, 'endpoint');

  return {
    provider,
    ...(displayName ? { displayName } : {}),
    ...(sourceLabel ? { sourceLabel } : {}),
    ...(protocol ? { protocol } : {}),
    ...(transportLabel ? { transportLabel } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
}

function normalizeExternalEngineReliability(value: unknown): AgentEngineReliability | undefined {
  if (!isRecord(value)) return undefined;
  const cliStatus = getEnumField(value, 'cliStatus', AGENT_ENGINE_CLI_STATUSES);
  const authState = getEnumField(value, 'authState', AGENT_ENGINE_AUTH_STATES);
  const quotaState = getEnumField(value, 'quotaState', AGENT_ENGINE_QUOTA_STATES);
  const streamingMode = getEnumField(value, 'streamingMode', AGENT_ENGINE_STREAMING_MODES);
  const toolSupport = getEnumField(value, 'toolSupport', AGENT_ENGINE_TOOL_SUPPORT);
  const transcriptMode = getEnumField(value, 'transcriptMode', AGENT_ENGINE_TRANSCRIPT_MODES);
  if (!cliStatus || !authState || !quotaState || !streamingMode || !toolSupport || !transcriptMode) {
    return undefined;
  }
  const partialMessages = getBooleanField(value, 'partialMessages');
  const mcpBridge = getBooleanField(value, 'mcpBridge');
  const notes = Array.isArray(value.notes)
    ? value.notes.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;

  return {
    cliStatus,
    authState,
    quotaState,
    streamingMode,
    toolSupport,
    transcriptMode,
    ...(partialMessages !== undefined ? { partialMessages } : {}),
    ...(mcpBridge !== undefined ? { mcpBridge } : {}),
    ...(notes && notes.length > 0 ? { notes } : {}),
  };
}

function normalizeExternalEngineFailureReliability(
  value: unknown,
): AgentEngineFailureDiagnostics['reliability'] | undefined {
  if (!isRecord(value)) return undefined;
  const authState = getEnumField(value, 'authState', AGENT_ENGINE_AUTH_STATES);
  const quotaState = getEnumField(value, 'quotaState', AGENT_ENGINE_QUOTA_STATES);
  const cliStatus = getEnumField(value, 'cliStatus', AGENT_ENGINE_CLI_STATUSES);
  if (!authState && !quotaState && !cliStatus) return undefined;
  return {
    ...(authState ? { authState } : {}),
    ...(quotaState ? { quotaState } : {}),
    ...(cliStatus ? { cliStatus } : {}),
  };
}

function normalizeExternalEngineFailure(value: unknown): AgentEngineFailureDiagnostics | undefined {
  if (!isRecord(value)) return undefined;
  const category = getEnumField(value, 'category', AGENT_ENGINE_FAILURE_CATEGORIES);
  const reason = getStringField(value, 'reason');
  const message = getStringField(value, 'message');
  const suggestion = getStringField(value, 'suggestion');
  if (!category || !reason || !message || !suggestion) return undefined;
  const occurredAt = getNumberField(value, 'occurredAt');
  const statusCode = getNumberField(value, 'statusCode');
  const exitCodeValue = value.exitCode;
  const exitCode = typeof exitCodeValue === 'number' || exitCodeValue === null ? exitCodeValue : undefined;
  const reliability = normalizeExternalEngineFailureReliability(value.reliability);

  return {
    category,
    reason,
    message,
    suggestion,
    retryable: getBooleanField(value, 'retryable') ?? false,
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(reliability ? { reliability } : {}),
  };
}

function normalizeExternalEngineSnapshot(value: unknown): ModelExternalEngineSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const kind = getEnumField(value, 'kind', EXTERNAL_AGENT_ENGINE_KINDS);
  const label = getStringField(value, 'label');
  const installState = getEnumField(value, 'installState', AGENT_ENGINE_INSTALL_STATES);
  const runtimeState = getEnumField(value, 'runtimeState', AGENT_ENGINE_RUNTIME_STATES);
  const executable = getBooleanField(value, 'executable');
  const rawCapabilities = value.capabilities;
  const capabilities = Array.isArray(rawCapabilities)
    ? rawCapabilities.filter((item): item is AgentEngineCapability =>
        typeof item === 'string' && AGENT_ENGINE_CAPABILITIES.has(item as AgentEngineCapability))
    : undefined;
  if (!kind || !label || !installState || !runtimeState || executable === undefined || !capabilities) {
    return undefined;
  }
  const model = getStringField(value, 'model');
  const reliability = normalizeExternalEngineReliability(value.reliability);
  const failure = normalizeExternalEngineFailure(value.failure);
  const command = getStringField(value, 'command');
  const version = getStringField(value, 'version');

  return {
    kind,
    label,
    installState,
    runtimeState,
    executable,
    capabilities,
    ...(model ? { model } : {}),
    ...(reliability ? { reliability } : {}),
    ...(failure ? { failure } : {}),
    ...(command ? { command } : {}),
    ...(version ? { version } : {}),
  };
}

function normalizeModelFallbackTraceSteps(value: unknown): ModelFallbackTraceStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = value
    .map((item): ModelFallbackTraceStep | null => {
      if (!isRecord(item)) return null;
      const provider = getStringField(item, 'provider');
      const status = getEnumField(item, 'status', MODEL_FALLBACK_TRACE_STATUSES);
      const reason = getStringField(item, 'reason');
      if (!provider || !status || !reason) return null;
	      const model = getStringField(item, 'model');
	      const category = getStringField(item, 'category');
	      const detail = getStringField(item, 'detail');
	      const providerIdentity = normalizeModelProviderIdentity(item.providerIdentity);
	      return {
	        provider,
	        status,
	        reason,
	        ...(model ? { model } : {}),
	        ...(providerIdentity ? { providerIdentity } : {}),
	        ...(category ? { category } : {}),
        ...(detail ? { detail } : {}),
      };
    })
    .filter((step): step is ModelFallbackTraceStep => step !== null);
  return steps.length > 0 ? steps : undefined;
}

function normalizeModelFallbackToolPolicy(value: unknown): ModelFallbackToolPolicy | undefined {
  if (!isRecord(value)) return undefined;
  if (value.status !== 'disabled') return undefined;
  if (value.reason !== 'fallback_model_without_tool_support') return undefined;
  const originalToolCount = getNumberField(value, 'originalToolCount');
  const effectiveToolCount = getNumberField(value, 'effectiveToolCount');
  if (originalToolCount === undefined || effectiveToolCount === undefined) return undefined;
  const disabledToolNames = Array.isArray(value.disabledToolNames)
    ? value.disabledToolNames.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;
  const detail = getStringField(value, 'detail');
  return {
    status: 'disabled',
    reason: 'fallback_model_without_tool_support',
    originalToolCount,
    effectiveToolCount,
    ...(disabledToolNames && disabledToolNames.length > 0 ? { disabledToolNames } : {}),
    ...(detail ? { detail } : {}),
  };
}

function normalizeToolStrategyDiagnostics(value: unknown): ModelToolStrategyDiagnostics | undefined {
  if (!isRecord(value)) return undefined;
  const visibleToolCount = getNumberField(value, 'visibleToolCount');
  const mcpToolCount = getNumberField(value, 'mcpToolCount');
  const programmaticToolCalling = getEnumField(value, 'programmaticToolCalling', PROGRAMMATIC_TOOL_CALLING_STATUSES);
  const programmaticToolCount = getNumberField(value, 'programmaticToolCount');
  if (
    visibleToolCount === undefined
    || mcpToolCount === undefined
    || !programmaticToolCalling
    || programmaticToolCount === undefined
  ) {
    return undefined;
  }
  const toolNamesPreview = Array.isArray(value.toolNamesPreview)
    ? value.toolNamesPreview.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;
  const mcpServerIds = Array.isArray(value.mcpServerIds)
    ? value.mcpServerIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : undefined;
  const tokenSavings = isRecord(value.tokenSavings)
    ? (() => {
      const status = getEnumField(value.tokenSavings, 'status', TOOL_TOKEN_SAVINGS_STATUSES);
      if (!status) return undefined;
      const savedTokens = getNumberField(value.tokenSavings, 'savedTokens');
      const detail = getStringField(value.tokenSavings, 'detail');
      const measurement = isRecord(value.tokenSavings.measurement)
        ? (() => {
          const savingsSource = getEnumField(
            value.tokenSavings.measurement,
            'savingsSource',
            TOOL_TOKEN_SAVINGS_MEASUREMENT_SOURCES,
          );
          const usageSource = getEnumField(
            value.tokenSavings.measurement,
            'usageSource',
            TOOL_TOKEN_SAVINGS_USAGE_SOURCES,
          );
          const providerReportedSavings = getBooleanField(value.tokenSavings.measurement, 'providerReportedSavings');
          if (!savingsSource || !usageSource || providerReportedSavings === undefined) return undefined;
          return {
            savingsSource,
            usageSource,
            providerReportedSavings,
          };
        })()
        : undefined;
      const providerUsage = isRecord(value.tokenSavings.providerUsage)
        ? (() => {
          const source = value.tokenSavings.providerUsage.source === 'model-response-usage'
            ? 'model-response-usage' as const
            : null;
          const inputTokens = getNumberField(value.tokenSavings.providerUsage, 'inputTokens');
          const outputTokens = getNumberField(value.tokenSavings.providerUsage, 'outputTokens');
          const totalTokens = getNumberField(value.tokenSavings.providerUsage, 'totalTokens');
          if (!source || inputTokens === undefined || outputTokens === undefined) return undefined;
          return {
            source,
            inputTokens,
            outputTokens,
            ...(totalTokens !== undefined ? { totalTokens } : {}),
          };
        })()
        : undefined;
      const basis = isRecord(value.tokenSavings.basis)
        ? (() => {
          const source = value.tokenSavings.basis.source === 'tool-spec-local-estimate'
            ? 'tool-spec-local-estimate' as const
            : null;
          const toolCount = getNumberField(value.tokenSavings.basis, 'toolCount');
          const previewToolCount = getNumberField(value.tokenSavings.basis, 'previewToolCount');
          const fields = Array.isArray(value.tokenSavings.basis.fields)
            ? value.tokenSavings.basis.fields.filter((field): field is 'name' | 'description' | 'inputSchema' => (
              field === 'name' || field === 'description' || field === 'inputSchema'
            ))
            : [];
          if (!source || toolCount === undefined || fields.length === 0) return undefined;
          return {
            source,
            toolCount,
            ...(previewToolCount !== undefined ? { previewToolCount } : {}),
            fields,
          };
        })()
        : undefined;
      const providerReport = isRecord(value.tokenSavings.providerReport)
        ? (() => {
          const source = value.tokenSavings.providerReport.source === 'provider-reported'
            ? 'provider-reported' as const
            : null;
          const reportSavedTokens = getNumberField(value.tokenSavings.providerReport, 'savedTokens');
          if (!source || reportSavedTokens === undefined) return undefined;
          return {
            source,
            savedTokens: reportSavedTokens,
          };
        })()
        : undefined;
      return {
        status,
        ...(savedTokens !== undefined ? { savedTokens } : {}),
        ...(detail ? { detail } : {}),
        ...(measurement ? { measurement } : {}),
        ...(basis ? { basis } : {}),
        ...(providerReport ? { providerReport } : {}),
        ...(providerUsage ? { providerUsage } : {}),
      };
    })()
    : undefined;
  return {
    visibleToolCount,
    ...(toolNamesPreview && toolNamesPreview.length > 0 ? { toolNamesPreview } : {}),
    mcpToolCount,
    ...(mcpServerIds && mcpServerIds.length > 0 ? { mcpServerIds } : {}),
    programmaticToolCalling,
    programmaticToolCount,
    ...(tokenSavings ? { tokenSavings } : {}),
  };
}

function normalizeTurnIdPayload(data: unknown): TurnIdPayload {
  if (!isRecord(data)) return {};
  return {
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
    ...(getBooleanField(data, 'isMeta') ? { isMeta: true } : {}),
  };
}

function normalizeStreamTextPayload(data: unknown): StreamTextPayload | null {
  if (!isRecord(data)) return null;
  const content = getStringField(data, 'content');
  if (content === undefined) return null;
  return {
    content,
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
    ...(getBooleanField(data, 'isMeta') ? { isMeta: true } : {}),
  };
}

function normalizeMessageDeltaPayload(data: unknown): MessageDeltaPayload | null {
  if (!isRecord(data) || data.role !== 'assistant') return null;
  const text = getStringField(data, 'text');
  if (text === undefined) return null;
  return {
    role: 'assistant',
    path: data.path === 'reasoning' ? 'reasoning' : 'content',
    op: data.op === 'replace' ? 'replace' : 'append',
    text,
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
    ...(getStringField(data, 'messageId') ? { messageId: getStringField(data, 'messageId') } : {}),
    ...(getBooleanField(data, 'isMeta') ? { isMeta: true } : {}),
  };
}

function normalizeMessageSnapshotPayload(data: unknown): MessageSnapshotPayload | null {
  if (!isRecord(data) || data.role !== 'assistant') return null;
  const content = getStringField(data, 'content');
  if (content === undefined) return null;
  return {
    role: 'assistant',
    content,
    ...(getStringField(data, 'reasoning') ? { reasoning: getStringField(data, 'reasoning') } : {}),
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
    ...(getStringField(data, 'messageId') ? { messageId: getStringField(data, 'messageId') } : {}),
    ...(getBooleanField(data, 'isMeta') ? { isMeta: true } : {}),
  };
}

function normalizeToolCall(value: unknown): ToolCall | null {
  if (!isRecord(value)) return null;
  const id = getStringField(value, 'id');
  const name = getStringField(value, 'name');
  if (!id || !name) return null;

  return {
    ...value,
    id,
    name,
    arguments: isRecord(value.arguments) ? value.arguments : {},
  } as ToolCall;
}

function normalizeToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(normalizeToolCall).filter((toolCall): toolCall is ToolCall => Boolean(toolCall));
}

function isArtifactType(value: unknown): value is NonNullable<Message['artifacts']>[number]['type'] {
  return (
    value === 'chart'
    || value === 'spreadsheet'
    || value === 'document'
    || value === 'generative_ui'
    || value === 'mermaid'
    || value === 'question_form'
  );
}

function normalizeArtifacts(value: unknown): Message['artifacts'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const artifacts = value.filter((item): item is NonNullable<Message['artifacts']>[number] => {
    if (!isRecord(item)) return false;
    return (
      typeof item.id === 'string'
      && isArtifactType(item.type)
      && typeof item.content === 'string'
      && typeof item.version === 'number'
    );
  });
  return artifacts.length > 0 ? artifacts : undefined;
}

function normalizeContentParts(value: unknown): Message['contentParts'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((item): item is NonNullable<Message['contentParts']>[number] => {
    if (!isRecord(item)) return false;
    if (item.type === 'text') return typeof item.text === 'string';
    if (item.type === 'tool_call') return typeof item.toolCallId === 'string';
    return false;
  });
  return parts.length > 0 ? parts : undefined;
}

function normalizeAssistantMessagePayload(data: unknown): AssistantMessagePayload | null {
  if (!isRecord(data)) return null;
  const toolCalls = normalizeToolCalls(data.toolCalls);
  const artifacts = normalizeArtifacts(data.artifacts);
  const contentParts = normalizeContentParts(data.contentParts);
  const modelDecision = normalizeModelDecisionPayload(data.modelDecision);
  return {
    ...(getStringField(data, 'id') ? { id: getStringField(data, 'id') } : {}),
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
    ...(getStringField(data, 'content') !== undefined ? { content: getStringField(data, 'content') } : {}),
    ...(getStringField(data, 'reasoning') !== undefined ? { reasoning: getStringField(data, 'reasoning') } : {}),
    ...(getStringField(data, 'thinking') !== undefined ? { thinking: getStringField(data, 'thinking') } : {}),
    ...(getBooleanField(data, 'isMeta') ? { isMeta: true } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(contentParts ? { contentParts } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(modelDecision ? { modelDecision } : {}),
  };
}

function normalizeRoutingResolvedPayload(data: unknown): RoutingResolvedPayload | null {
  if (!isRecord(data) || data.mode !== 'auto') return null;
  const agentId = getStringField(data, 'agentId');
  const agentName = getStringField(data, 'agentName');
  const reason = getStringField(data, 'reason');
  const score = getNumberField(data, 'score');
  if (!agentId || !agentName || !reason || score === undefined) return null;

  return {
    mode: 'auto',
    agentId,
    agentName,
    reason,
    score,
    ...(getNumberField(data, 'timestamp') !== undefined ? { timestamp: getNumberField(data, 'timestamp') } : {}),
    ...(getBooleanField(data, 'fallbackToDefault') !== undefined ? { fallbackToDefault: getBooleanField(data, 'fallbackToDefault') } : {}),
  };
}

function normalizeModelDecisionPayload(data: unknown): ModelDecisionEventData | null {
  if (!isRecord(data)) return null;
  const requestedProvider = getStringField(data, 'requestedProvider');
  const requestedModel = getStringField(data, 'requestedModel');
  const resolvedProvider = getStringField(data, 'resolvedProvider');
  const resolvedModel = getStringField(data, 'resolvedModel');
  const reason = getStringField(data, 'reason') as ModelDecisionReason | undefined;
  const billingMode = getStringField(data, 'billingMode') as BillingMode | undefined;
  if (
    !requestedProvider
    || !requestedModel
    || !resolvedProvider
    || !resolvedModel
    || !reason
    || !MODEL_DECISION_REASONS.has(reason)
    || !billingMode
    || !BILLING_MODES.has(billingMode)
  ) {
    return null;
  }

  const strategySummary = getStringField(data, 'strategySummary');
  const complexityScore = getNumberField(data, 'complexityScore');
  const taskClass = getEnumField(data, 'taskClass', MODEL_TASK_CLASSES);
  const costPolicy = getEnumField(data, 'costPolicy', MODEL_COST_POLICIES);
  const speedPolicy = getEnumField(data, 'speedPolicy', MODEL_SPEED_POLICIES);
  const toolPolicy = getEnumField(data, 'toolPolicy', MODEL_TOOL_POLICIES);
  const toolStrategy = normalizeToolStrategyDiagnostics(data.toolStrategy);
  const capabilityNeeds = getEnumArrayField(data, 'capabilityNeeds', MODEL_CAPABILITY_NEEDS);
  const providerHealthSnapshot = normalizeProviderHealthSnapshot(data.providerHealthSnapshot);
  const providerIdentity = normalizeModelProviderIdentity(data.providerIdentity);
  const externalEngine = normalizeExternalEngineSnapshot(data.externalEngine);

  return {
    requestedProvider,
    requestedModel,
    resolvedProvider,
    resolvedModel,
    reason,
    billingMode,
    role: getStringField(data, 'role') ?? null,
    fallbackFrom: getStringField(data, 'fallbackFrom') ?? null,
    ...(getStringField(data, 'turnId') ? { turnId: getStringField(data, 'turnId') } : {}),
    ...(getNumberField(data, 'timestamp') !== undefined ? { timestamp: getNumberField(data, 'timestamp') } : {}),
    ...(strategySummary ? { strategySummary } : {}),
    ...(complexityScore !== undefined ? { complexityScore } : {}),
    ...(taskClass ? { taskClass } : {}),
    ...(costPolicy ? { costPolicy } : {}),
    ...(speedPolicy ? { speedPolicy } : {}),
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(toolStrategy ? { toolStrategy } : {}),
    ...(capabilityNeeds ? { capabilityNeeds } : {}),
    ...(providerHealthSnapshot ? { providerHealthSnapshot } : {}),
    ...(providerIdentity ? { providerIdentity } : {}),
    ...(externalEngine ? { externalEngine } : {}),
  };
}

function normalizeModelFallbackPayload(data: unknown): ModelFallbackPayload | null {
  if (!isRecord(data)) return null;
  const reason = getStringField(data, 'reason');
  const from = getStringField(data, 'from');
  const to = getStringField(data, 'to');
  if (!reason || !from || !to) return null;
  const category = getStringField(data, 'category');
  const strategy = getStringField(data, 'strategy');
  const tried = normalizeModelFallbackTraceSteps(data.tried);
  const skipped = normalizeModelFallbackTraceSteps(data.skipped);
  const toolPolicy = normalizeModelFallbackToolPolicy(data.toolPolicy);
  const fromIdentity = normalizeModelProviderIdentity(data.fromIdentity);
  const toIdentity = normalizeModelProviderIdentity(data.toIdentity);
  return {
    reason,
    from,
    to,
    ...(category ? { category } : {}),
    ...(strategy && MODEL_FALLBACK_STRATEGIES.has(strategy as ModelFallbackStrategy)
      ? { strategy: strategy as ModelFallbackStrategy }
      : {}),
    ...(tried ? { tried } : {}),
    ...(skipped ? { skipped } : {}),
    ...(toolPolicy ? { toolPolicy } : {}),
    ...(fromIdentity ? { fromIdentity } : {}),
    ...(toIdentity ? { toIdentity } : {}),
  };
}

function normalizeHookTriggerData(data: unknown): HookTriggerEventData | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const raw = data as Partial<HookTriggerEventData>;
  const sources = Array.isArray(raw.sources)
    ? raw.sources.filter((source): source is 'global' | 'project' => source === 'global' || source === 'project')
    : [];
  const hookType = raw.hookType === 'decision' || raw.hookType === 'observer'
    ? raw.hookType
    : 'observer';
  if (
    typeof raw.timestamp !== 'number'
    || typeof raw.event !== 'string'
    || (raw.action !== 'allow' && raw.action !== 'block')
    || typeof raw.durationMs !== 'number'
    || typeof raw.hookCount !== 'number'
  ) {
    return null;
  }

  return {
    timestamp: raw.timestamp,
    event: raw.event,
    action: raw.action,
    durationMs: raw.durationMs,
    hookCount: raw.hookCount,
    modified: Boolean(raw.modified),
    sources,
    hookType,
    ...(typeof raw.errorCount === 'number' ? { errorCount: raw.errorCount } : {}),
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.turnId === 'string' ? { turnId: raw.turnId } : {}),
    ...(typeof raw.toolName === 'string' ? { toolName: raw.toolName } : {}),
    ...(typeof raw.matcher === 'string' ? { matcher: raw.matcher } : {}),
  };
}

export function removeUncommittedAssistantDraft(
  messages: Message[],
  draftMessageId: string | null | undefined,
): Message[] {
  if (!draftMessageId) return messages;

  const draft = messages.find((message) => message.id === draftMessageId);
  if (draft?.role !== 'assistant') return messages;

  const hasToolCalls = (draft.toolCalls?.length || 0) > 0;
  if (hasToolCalls) return messages;

  return messages.filter((message) => message.id !== draftMessageId);
}

export function mergeCommittedAssistantContent(
  existingContent: string,
  committedContent: string,
): string {
  if (!committedContent) return existingContent;
  if (!existingContent) return committedContent;
  if (existingContent === committedContent) return existingContent;
  return committedContent;
}

export interface ConversationStreamState {
  currentTurnMessageId: string | null;
  committedAssistantMessageIds: Set<string>;
}

interface ConversationStreamEventActions {
  addMessage: (message: Message) => void;
  appendStreamingMessageDelta?: (messageId: string, delta: { content?: string; reasoning?: string }) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setMessages: (messages: Message[]) => void;
  getMessages: () => Message[];
  queueUpdate: (update: Parameters<AgentEffectsProps['queueUpdate']>[0]) => void;
  now?: () => number;
  generateId?: () => string;
}

function appendAssistantStreamDelta(
  actions: ConversationStreamEventActions,
  messageId: string,
  delta: { content?: string; reasoning?: string },
): void {
  if (actions.appendStreamingMessageDelta) {
    actions.appendStreamingMessageDelta(messageId, delta);
    return;
  }

  actions.queueUpdate({
    type: 'append',
    messageId,
    ...delta,
  });
}

export function applyConversationStreamEvent(
  event: AgentEvent,
  state: ConversationStreamState,
  actions: ConversationStreamEventActions,
): void {
  const now = actions.now ?? Date.now;
  const makeId = actions.generateId ?? generateMessageId;
  const getFreshMessages = actions.getMessages;

  switch (event.type) {
    case 'turn_start':
      if (
        state.currentTurnMessageId &&
        !state.committedAssistantMessageIds.has(state.currentTurnMessageId)
      ) {
        const messages = getFreshMessages();
        const cleanedMessages = removeUncommittedAssistantDraft(
          messages,
          state.currentTurnMessageId,
        );
        if (cleanedMessages !== messages) {
          actions.setMessages(cleanedMessages);
        }
      }

      {
        const turnData = normalizeTurnIdPayload(event.data);
        const turnId = turnData.turnId || makeId();
        if (turnData.isMeta) {
          state.currentTurnMessageId = turnId;
          state.committedAssistantMessageIds.delete(turnId);
          break;
        }
        const newMessage: Message = {
          id: turnId,
          role: 'assistant',
          content: '',
          timestamp: now(),
          toolCalls: [],
        };
        actions.addMessage(newMessage);
        state.currentTurnMessageId = turnId;
        state.committedAssistantMessageIds.delete(turnId);
      }
      break;

    case 'stream_chunk':
      {
        const chunkData = normalizeStreamTextPayload(event.data);
        if (!chunkData?.content) break;
        if (chunkData.isMeta) break;
        const targetMessageId = chunkData.turnId || state.currentTurnMessageId;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          appendAssistantStreamDelta(actions, targetMessage.id, {
            content: chunkData.content,
          });
        } else if (targetMessageId) {
          break;
        } else {
          const lastMessage = getFreshMessages()[getFreshMessages().length - 1];
          if (lastMessage?.role === 'assistant') {
            const hasCompletedToolCalls = lastMessage.toolCalls?.some(
              (tc: ToolCall) => tc.result !== undefined
            );
            if (hasCompletedToolCalls) {
              const newMessage: Message = {
                id: makeId(),
                role: 'assistant',
                content: chunkData.content,
                timestamp: now(),
                toolCalls: [],
              };
              actions.addMessage(newMessage);
              state.currentTurnMessageId = newMessage.id;
              state.committedAssistantMessageIds.delete(newMessage.id);
            } else {
              appendAssistantStreamDelta(actions, lastMessage.id, {
                content: chunkData.content,
              });
            }
          }
        }
      }
      break;

    case 'message_delta':
      {
        const deltaData = normalizeMessageDeltaPayload(event.data);
        if (!deltaData?.text) break;
        if (deltaData.isMeta) break;
        const targetMessageId = deltaData.messageId || deltaData.turnId || state.currentTurnMessageId;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          const field = deltaData.path === 'reasoning' ? 'reasoning' : 'content';
          if (deltaData.op === 'replace') {
            actions.updateMessage(targetMessage.id, field === 'reasoning'
              ? { reasoning: deltaData.text }
              : { content: deltaData.text });
          } else {
            appendAssistantStreamDelta(actions, targetMessage.id, field === 'reasoning'
              ? { reasoning: deltaData.text }
              : { content: deltaData.text });
          }
        }
      }
      break;

    case 'message_snapshot':
      {
        const snapshotData = normalizeMessageSnapshotPayload(event.data);
        if (!snapshotData) break;
        if (snapshotData.isMeta) break;
        const targetMessageId = snapshotData.turnId || snapshotData.messageId || state.currentTurnMessageId;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          actions.updateMessage(targetMessage.id, {
            content: snapshotData.content,
            reasoning: snapshotData.reasoning,
          });
        }
      }
      break;

    case 'model_decision':
      {
        const decisionData = normalizeModelDecisionPayload(event.data);
        if (!decisionData) break;
        if (isRecord(event.data) && getBooleanField(event.data, 'isMeta')) break;
        const targetMessageId = decisionData.turnId || state.currentTurnMessageId;
        const freshMsgs = getFreshMessages();
        const targetMessage = targetMessageId
          ? freshMsgs.find(m => m.id === targetMessageId)
          : freshMsgs[freshMsgs.length - 1];

        if (targetMessage?.role === 'assistant') {
          actions.updateMessage(targetMessage.id, {
            modelDecision: decisionData,
          });
        }
      }
      break;

    case 'model_fallback':
      {
        const fallbackData = normalizeModelFallbackPayload(event.data);
        if (!fallbackData) break;
        actions.addMessage(buildModelFallbackNoticeMessage(fallbackData));
      }
      break;

    case 'message':
      {
        const messageData = normalizeAssistantMessagePayload(event.data);
        if (!messageData) break;
        const targetMessageId = messageData.turnId || state.currentTurnMessageId;
        const targetMessage = targetMessageId
          ? getFreshMessages().find(m => m.id === targetMessageId)
          : getFreshMessages()[getFreshMessages().length - 1];

        if (messageData.isMeta) {
          if (targetMessage?.role === 'assistant') {
            actions.setMessages(getFreshMessages().filter((message) => message.id !== targetMessage.id));
          }
          if (targetMessageId) {
            state.committedAssistantMessageIds.add(targetMessageId);
          }
          if (messageData.id) {
            state.committedAssistantMessageIds.add(messageData.id);
          }
          break;
        }

        if (targetMessage?.role === 'assistant') {
          state.committedAssistantMessageIds.add(targetMessage.id);
          if (messageData.id) {
            state.committedAssistantMessageIds.add(messageData.id);
          }

          const existingContent = targetMessage.content || '';
          const newContent = messageData.content || '';

          let mergedToolCalls = targetMessage.toolCalls;
          if (messageData.toolCalls && messageData.toolCalls.length > 0) {
            const existingToolCalls = targetMessage.toolCalls || [];
            if (existingToolCalls.length > 0) {
              const fromEvent = new Map<string, ToolCall>(
                messageData.toolCalls.map((tc: ToolCall) => [tc.id, tc] as [string, ToolCall]),
              );
              mergedToolCalls = existingToolCalls.map((existing: ToolCall) => {
                const fresh = fromEvent.get(existing.id);
                if (!fresh) return existing;
                return {
                  ...existing,
                  shortDescription: fresh.shortDescription ?? existing.shortDescription,
                  targetContext: fresh.targetContext ?? existing.targetContext,
                  expectedOutcome: fresh.expectedOutcome ?? existing.expectedOutcome,
                  arguments: fresh.arguments ?? existing.arguments,
                };
              });
              const existingIds = new Set(existingToolCalls.map((tc: ToolCall) => tc.id));
              const newOnes = messageData.toolCalls.filter(
                (tc: ToolCall) => !existingIds.has(tc.id)
              );
              if (newOnes.length > 0) {
                mergedToolCalls = [...mergedToolCalls, ...newOnes];
              }
            } else {
              mergedToolCalls = messageData.toolCalls;
            }
          }

          actions.updateMessage(targetMessage.id, {
            content: mergeCommittedAssistantContent(existingContent, newContent),
            toolCalls: mergedToolCalls,
            ...(messageData.reasoning !== undefined ? { reasoning: messageData.reasoning } : {}),
            ...(messageData.thinking !== undefined ? { thinking: messageData.thinking } : {}),
            ...(messageData.isMeta !== undefined ? { isMeta: messageData.isMeta } : {}),
            ...(messageData.contentParts ? { contentParts: messageData.contentParts } : {}),
            ...(messageData.artifacts ? { artifacts: messageData.artifacts } : {}),
            ...(messageData.modelDecision ? { modelDecision: messageData.modelDecision } : {}),
          });
        }
      }
      break;

    case 'stream_reasoning':
      {
        const reasoningData = normalizeStreamTextPayload(event.data);
        if (!reasoningData?.content) break;
        if (reasoningData.isMeta) break;
        const targetMessageId = reasoningData.turnId || state.currentTurnMessageId;
        const targetMessage = targetMessageId
          ? getFreshMessages().find(m => m.id === targetMessageId)
          : getFreshMessages()[getFreshMessages().length - 1];

        if (targetMessage?.role === 'assistant') {
          appendAssistantStreamDelta(actions, targetMessage.id, {
            reasoning: reasoningData.content,
          });
        }
      }
      break;
  }
}

export const useConversationStreamEffects = ({
  addMessage,
  appendStreamingMessageDelta,
  currentTurnMessageIdRef,
  flushStreamingMessages,
  flushRef,
  lastEventAtRef,
  queueUpdate,
  updateMessage,
  setTodos,
  setIsProcessing,
  setPendingPermissionRequest,
  enqueuePermissionRequest,
  setSessionTaskProgress,
  setSessionTaskComplete,
}: AgentEffectsProps) => {
  const committedAssistantMessageIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: AgentEvent) => {
      const currentSessionId = useSessionStore.getState().currentSessionId;
      const eventSessionId = getAgentEventSessionId(event);
      const isCurrentSessionEvent = isAgentEventForCurrentSession(event, currentSessionId);
      const getFreshMessages = () => useSessionStore.getState().messages;
      const logHandledEvent = () => {
        const silentEvents = ['message_delta', 'message_snapshot', 'stream_chunk', 'stream_reasoning'];
        if (!silentEvents.includes(event.type)) {
          logger.debug('Received event', { type: event.type, sessionId: event.sessionId });
        }
      };

      switch (event.type) {
        case 'agent_complete':
        case 'agent_cancelled':
        case 'error':
        case 'stream_end':
          flushRef.current();
          flushStreamingMessages();
          return;

        // /goal 自治模式：进度 / 闸判定 / 终态（per-session 更新 appStore；终态在当前会话补一条生命周期消息）
        // 注：本文件的 event 是 loose 类型（data?: unknown），按 contract 的 AgentEvent 形状断言。
        case 'goal_iteration': {
          logHandledEvent();
          if (eventSessionId) {
            const d = event.data as { turn: number; maxTurns: number; tokensUsed: number; tokenBudget: number; wallClockBudgetMs?: number };
            useAppStore.getState().updateGoalProgress(eventSessionId, {
              turn: d.turn,
              maxTurns: d.maxTurns,
              tokensUsed: d.tokensUsed,
              tokenBudget: d.tokenBudget,
              wallClockBudgetMs: d.wallClockBudgetMs,
            });
          }
          break;
        }

        case 'goal_gate': {
          logHandledEvent();
          if (eventSessionId) {
            const d = event.data as { gate: number; pass: boolean; reason?: string };
            useAppStore.getState().recordGoalGate(eventSessionId, {
              gate: d.gate,
              pass: d.pass,
              reason: d.reason,
            });
          }
          break;
        }

        case 'goal_complete': {
          logHandledEvent();
          if (eventSessionId) {
            const d = event.data as { status: 'met' | 'aborted'; reason?: string; turns: number; tokensUsed: number };
            const appStore = useAppStore.getState();
            const run = appStore.goalRuns[eventSessionId];
            appStore.finishGoalRun(eventSessionId, d.status, d.reason);
            if (isCurrentSessionEvent) {
              addMessage(buildGoalNoticeMessage({
                kind: d.status === 'met' ? 'met' : 'aborted',
                goal: run?.goal ?? '',
                reason: d.reason,
                turns: d.turns,
                tokensUsed: d.tokensUsed,
                durationMs: run ? Date.now() - run.startedAt : undefined,
              }));
            }
          }
          break;
        }

        case 'turn_start':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          flushRef.current();
          flushStreamingMessages();
          applyConversationStreamEvent(
            event,
            {
              get currentTurnMessageId() {
                return currentTurnMessageIdRef.current;
              },
              set currentTurnMessageId(value) {
                currentTurnMessageIdRef.current = value;
              },
              committedAssistantMessageIds: committedAssistantMessageIdsRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
          logger.debug('turn_start - created message', { turnId: currentTurnMessageIdRef.current, sessionId: eventSessionId });
          break;

        case 'stream_chunk':
        case 'message_delta':
        case 'message_snapshot':
        case 'model_decision':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          applyConversationStreamEvent(
            event,
            {
              get currentTurnMessageId() {
                return currentTurnMessageIdRef.current;
              },
              set currentTurnMessageId(value) {
                currentTurnMessageIdRef.current = value;
              },
              committedAssistantMessageIds: committedAssistantMessageIdsRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
          break;

        case 'message':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          flushRef.current();
          flushStreamingMessages();
          applyConversationStreamEvent(
            event,
            {
              get currentTurnMessageId() {
                return currentTurnMessageIdRef.current;
              },
              set currentTurnMessageId(value) {
                currentTurnMessageIdRef.current = value;
              },
              committedAssistantMessageIds: committedAssistantMessageIdsRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
          break;

        case 'turn_end':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          flushRef.current();
          flushStreamingMessages();
          logger.debug('turn_end', { turnId: normalizeTurnIdPayload(event.data).turnId });
          break;

        case 'routing_resolved':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          {
            const routingData = normalizeRoutingResolvedPayload(event.data);
            if (!eventSessionId || !routingData) {
              break;
            }
            useTurnExecutionStore.getState().recordRoutingEvidence(eventSessionId, {
              kind: 'auto',
              mode: 'auto',
              timestamp: routingData.timestamp || Date.now(),
              agentId: routingData.agentId,
              agentName: routingData.agentName,
              reason: routingData.reason,
              score: routingData.score,
              fallbackToDefault: routingData.fallbackToDefault,
            });
          }
          break;

        case 'model_fallback':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          applyConversationStreamEvent(
            event,
            {
              get currentTurnMessageId() {
                return currentTurnMessageIdRef.current;
              },
              set currentTurnMessageId(value) {
                currentTurnMessageIdRef.current = value;
              },
              committedAssistantMessageIds: committedAssistantMessageIdsRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
          break;

        case 'hook_trigger':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          {
            const hookData = normalizeHookTriggerData(event.data);
            if (eventSessionId && hookData) {
              useTurnExecutionStore.getState().recordHookActivity(eventSessionId, hookData);
            }
          }
          break;

        case 'stream_reasoning':
          lastEventAtRef.current = Date.now();
          logHandledEvent();
          if (!isCurrentSessionEvent) {
            break;
          }
          applyConversationStreamEvent(
            event,
            {
              get currentTurnMessageId() {
                return currentTurnMessageIdRef.current;
              },
              set currentTurnMessageId(value) {
                currentTurnMessageIdRef.current = value;
              },
              committedAssistantMessageIds: committedAssistantMessageIdsRef.current,
            },
            {
              addMessage,
              appendStreamingMessageDelta,
              updateMessage,
              setMessages: (messages) => useSessionStore.getState().setMessages(messages),
              getMessages: getFreshMessages,
              queueUpdate,
            },
          );
          break;
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [
    updateMessage,
    appendStreamingMessageDelta,
    setTodos,
    setIsProcessing,
    setPendingPermissionRequest,
    enqueuePermissionRequest,
    setSessionTaskProgress,
    setSessionTaskComplete,
    flushRef,
    flushStreamingMessages,
    queueUpdate,
    addMessage,
    currentTurnMessageIdRef,
    lastEventAtRef,
  ]);
};

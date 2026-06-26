// ============================================================================
// Telemetry Storage parsers — 纯解析 / guard / row-mapper（零行为改动）
// 从 telemetryStorage.ts 拆出；TelemetryStorage 各方法 import 使用。
// ============================================================================

import { randomUUID } from 'crypto';
import type { TelemetrySession, TelemetryTurn, TelemetryModelCall, TelemetryToolCall, TelemetryTimelineEvent, ComputerSurfaceReliabilitySummary, QualitySignals, TelemetryFeedback, TelemetryRendererBundleAttempt } from '../../shared/contract/telemetry';
import type { RendererBundleStatus } from '../../shared/contract/update';
import { TELEMETRY_RAW } from '../../shared/constants';
import { guardSensitiveJsonText, guardSensitiveText, guardSensitiveValue } from '../security/sensitiveDataGuard';
import { redactSecrets } from '../security/secretRedaction';

export const DEFAULT_QUALITY_SIGNALS: QualitySignals = {
  toolSuccessRate: 0,
  toolCallCount: 0,
  retryCount: 0,
  errorCount: 0,
  errorRecovered: 0,
  compactionTriggered: false,
  circuitBreakerTripped: false,
  nudgesInjected: 0,
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStringArrayJson(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const parsed: unknown = JSON.parse(value || '[]');
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
}

export function parseQualitySignalsJson(value: unknown): QualitySignals {
  if (typeof value !== 'string') return DEFAULT_QUALITY_SIGNALS;
  const parsed: unknown = JSON.parse(value || '{}');
  if (!isRecord(parsed)) return DEFAULT_QUALITY_SIGNALS;
  return {
    toolSuccessRate: typeof parsed.toolSuccessRate === 'number' ? parsed.toolSuccessRate : DEFAULT_QUALITY_SIGNALS.toolSuccessRate,
    toolCallCount: typeof parsed.toolCallCount === 'number' ? parsed.toolCallCount : DEFAULT_QUALITY_SIGNALS.toolCallCount,
    retryCount: typeof parsed.retryCount === 'number' ? parsed.retryCount : DEFAULT_QUALITY_SIGNALS.retryCount,
    errorCount: typeof parsed.errorCount === 'number' ? parsed.errorCount : DEFAULT_QUALITY_SIGNALS.errorCount,
    errorRecovered: typeof parsed.errorRecovered === 'number' ? parsed.errorRecovered : DEFAULT_QUALITY_SIGNALS.errorRecovered,
    compactionTriggered: typeof parsed.compactionTriggered === 'boolean' ? parsed.compactionTriggered : DEFAULT_QUALITY_SIGNALS.compactionTriggered,
    circuitBreakerTripped: typeof parsed.circuitBreakerTripped === 'boolean' ? parsed.circuitBreakerTripped : DEFAULT_QUALITY_SIGNALS.circuitBreakerTripped,
    nudgesInjected: typeof parsed.nudgesInjected === 'number' ? parsed.nudgesInjected : DEFAULT_QUALITY_SIGNALS.nudgesInjected,
  };
}

export function parseFallbackInfoJson(value: unknown): TelemetryModelCall['fallbackUsed'] {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) return undefined;
  return typeof parsed.from === 'string' && typeof parsed.to === 'string' && typeof parsed.reason === 'string'
    ? { from: parsed.from, to: parsed.to, reason: parsed.reason }
    : undefined;
}

export function parseTelemetryJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function parseTelemetryTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export const truncate = (value: string | undefined | null, limit: number): string | null => {
  if (typeof value !== 'string') return null;
  return value.substring(0, limit);
};

export const guardTelemetryText = (value: string | undefined | null, limit: number): string | null => {
  if (typeof value !== 'string') return null;
  return truncate(
    guardSensitiveText(value, {
      surface: 'telemetry',
      mode: 'diagnostic',
      maxLength: limit * 2
    }),
    limit
  );
};

/**
 * raw 旁表用:仅做密钥掩码(不跑 PII/注入中和/聚合截断),保留诊断全量。
 * 单条超 PER_PAYLOAD_MAX_BYTES 按字节截断并标记 truncated + 记原始字节长度。
 */
export const prepareRawPayload = (
  value: string | undefined | null,
): { content: string; byteLen: number; truncated: boolean } | null => {
  if (typeof value !== 'string' || value.length === 0) return null;
  const masked = redactSecrets(value);
  const fullBytes = Buffer.byteLength(masked, 'utf8');
  const cap = TELEMETRY_RAW.PER_PAYLOAD_MAX_BYTES;
  if (fullBytes <= cap) {
    return { content: masked, byteLen: fullBytes, truncated: false };
  }
  // 按字节安全截断(避免切断多字节字符)
  const content = Buffer.from(masked, 'utf8').subarray(0, cap).toString('utf8');
  return { content, byteLen: fullBytes, truncated: true };
};

export const guardTelemetryJsonText = (value: string | undefined | null, limit: number): string | null => {
  if (typeof value !== 'string') return null;
  const guarded = guardSensitiveJsonText(value, {
    surface: 'telemetry',
    mode: 'diagnostic',
    maxLength: limit * 2
  });
  return truncate(guarded, limit);
};

export const stringifyGuardedTelemetry = (value: unknown): string =>
  JSON.stringify(
    guardSensitiveValue(value, {
      surface: 'telemetry',
      mode: 'diagnostic',
      maxLength: 20_000
    })
  );

export const emptyComputerSurfaceReliabilitySummary = (sessionId: string): ComputerSurfaceReliabilitySummary => ({
  sessionId,
  totalActions: 0,
  successfulActions: 0,
  failedActions: 0,
  foregroundFallbackActions: 0,
  backgroundAxActions: 0,
  backgroundCgEventActions: 0,
  byFailureKind: [],
  byMode: [],
  recentFailures: []
});


export function rowToSession(row: Record<string, unknown>): TelemetrySession {
  return {
    id: row.id as string,
    userId: row.user_id == null ? null : String(row.user_id),
    title: row.title as string,
    modelProvider: row.model_provider as string,
    modelName: row.model_name as string,
    workingDirectory: row.working_directory as string,
    startTime: row.start_time as number,
    endTime: row.end_time as number | undefined,
    durationMs: row.duration_ms as number | undefined,
    turnCount: row.turn_count as number,
    totalInputTokens: row.total_input_tokens as number,
    totalOutputTokens: row.total_output_tokens as number,
    totalTokens: row.total_tokens as number,
    estimatedCost: row.estimated_cost as number,
    totalToolCalls: row.total_tool_calls as number,
    toolSuccessRate: row.tool_success_rate as number,
    totalErrors: row.total_errors as number,
    sessionType: (row.session_type as TelemetrySession['sessionType']) ?? undefined,
    status: row.status as TelemetrySession['status'],
    agentVersion: (row.agent_version as string | null) ?? undefined,
    promptVersion: (row.prompt_version as string | null) ?? undefined,
    toolSchemaVersion: (row.tool_schema_version as string | null) ?? undefined,
  };
}

export function rowToTurn(row: Record<string, unknown>): TelemetryTurn {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    agentId: (row.agent_id as string) || 'main',
    turnNumber: row.turn_number as number,
    startTime: row.start_time as number,
    endTime: row.end_time as number,
    durationMs: row.duration_ms as number,
    userPrompt: row.user_prompt as string,
    userPromptTokens: row.user_prompt_tokens as number,
    hasAttachments: !!(row.has_attachments as number),
    attachmentCount: row.attachment_count as number,
    systemPromptHash: row.system_prompt_hash as string | undefined,
    agentMode: row.agent_mode as string,
    activeSkills: parseStringArrayJson(row.active_skills),
    activeMcpServers: parseStringArrayJson(row.active_mcp_servers),
    effortLevel: row.effort_level as string,
    modelCalls: [],
    toolCalls: [],
    assistantResponse: row.assistant_response as string,
    assistantResponseTokens: row.assistant_response_tokens as number,
    thinkingContent: row.thinking_content as string | undefined,
    totalInputTokens: row.total_input_tokens as number,
    totalOutputTokens: row.total_output_tokens as number,
    events: [],
    intent: {
      primary: row.intent_primary as TelemetryTurn['intent']['primary'],
      secondary: row.intent_secondary as TelemetryTurn['intent']['secondary'],
      confidence: row.intent_confidence as number,
      method: row.intent_method as 'rule' | 'llm',
      keywords: parseStringArrayJson(row.intent_keywords)
    },
    outcome: {
      status: row.outcome_status as TelemetryTurn['outcome']['status'],
      confidence: row.outcome_confidence as number,
      method: row.outcome_method as 'rule' | 'llm',
      signals: parseQualitySignalsJson(row.quality_signals)
    },
    compactionOccurred: !!(row.compaction_occurred as number),
    compactionSavedTokens: row.compaction_saved_tokens as number | undefined,
    iterationCount: row.iteration_count as number,
    turnType: (row.turn_type as 'user' | 'iteration') ?? 'user',
    parentTurnId: row.parent_turn_id as string | undefined
  };
}

export function rowToModelCall(row: Record<string, unknown>): TelemetryModelCall {
  return {
    id: row.id as string,
    timestamp: row.timestamp as number,
    provider: row.provider as string,
    model: row.model as string,
    temperature: row.temperature as number | undefined,
    maxTokens: row.max_tokens as number | undefined,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    latencyMs: row.latency_ms as number,
    responseType: row.response_type as TelemetryModelCall['responseType'],
    toolCallCount: row.tool_call_count as number,
    truncated: !!(row.truncated as number),
    error: row.error as string | undefined,
    fallbackUsed: parseFallbackInfoJson(row.fallback_info),
    prompt: row.prompt as string | undefined,
    completion: row.completion as string | undefined
  };
}

export function rowToToolCall(row: Record<string, unknown>): TelemetryToolCall {
  return {
    id: row.id as string,
    toolCallId: row.tool_call_id as string,
    name: row.name as string,
    arguments: row.arguments as string,
    actualArguments: row.actual_arguments as string | undefined,
    resultSummary: row.result_summary as string,
    success: !!(row.success as number),
    error: row.error as string | undefined,
    errorCategory: row.error_category as TelemetryToolCall['errorCategory'],
    computerSurfaceFailureKind: row.computer_surface_failure_kind as string | undefined,
    computerSurfaceMode: row.computer_surface_mode as string | undefined,
    computerSurfaceTargetApp: row.computer_surface_target_app as string | undefined,
    computerSurfaceAction: row.computer_surface_action as string | undefined,
    computerSurfaceAxQualityScore: row.computer_surface_ax_quality_score as number | undefined,
    computerSurfaceAxQualityGrade: row.computer_surface_ax_quality_grade as string | undefined,
    durationMs: row.duration_ms as number,
    timestamp: row.timestamp as number,
    index: row.idx as number,
    parallel: !!(row.parallel as number)
  };
}

export function rowToFeedback(row: Record<string, unknown>): TelemetryFeedback {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    turnId: row.turn_id == null ? null : String(row.turn_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    rating: row.rating === -1 ? -1 : 1,
    comment: row.comment == null ? null : String(row.comment),
    fullContent: parseTelemetryJson(row.full_content),
    createdAt: row.created_at as number,
    syncedAt: row.synced_at == null ? null : row.synced_at as number,
  };
}

export function rowToRendererBundleAttempt(row: Record<string, unknown>): TelemetryRendererBundleAttempt {
  return {
    id: row.id as string,
    checkedAt: Number(row.checked_at ?? 0),
    manifestUrl: row.manifest_url as string,
    sourceChannel: row.source_channel == null ? null : String(row.source_channel),
    sourceManifestUrlOverride: !!(row.source_manifest_url_override as number),
    sourceErrorReason: row.source_error_reason == null ? null : String(row.source_error_reason),
    sourceErrorMessage: row.source_error_message == null ? null : String(row.source_error_message),
    sourceErrorTarget: row.source_error_target == null ? null : String(row.source_error_target),
    currentShellVersion: row.current_shell_version as string,
    activeVersion: row.active_version == null ? null : String(row.active_version),
    activeContentHash: row.active_content_hash == null ? null : String(row.active_content_hash),
    outcome: row.outcome as TelemetryRendererBundleAttempt['outcome'],
    reason: row.reason == null ? null : String(row.reason),
    manifestVersion: row.manifest_version == null ? null : String(row.manifest_version),
    manifestContentHash: row.manifest_content_hash == null ? null : String(row.manifest_content_hash),
    manifestMinShellVersion: row.manifest_min_shell_version == null ? null : String(row.manifest_min_shell_version),
    manifestBundleUrl: row.manifest_bundle_url == null ? null : String(row.manifest_bundle_url),
    requiredShellCapabilitiesCount: Number(row.required_shell_capabilities_count ?? 0),
    rollbackToBuiltin: !!(row.rollback_to_builtin as number),
    rollbackReason: row.rollback_reason == null ? null : String(row.rollback_reason),
    missingShellCapabilities: parseStringArrayJson(row.missing_shell_capabilities),
    missingRuntimeAssets: parseStringArrayJson(row.missing_runtime_assets),
    missingResources: parseStringArrayJson(row.missing_resources),
    diagnostics: parseStringArrayJson(row.diagnostics),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    syncedAt: row.synced_at == null ? null : row.synced_at as number,
  };
}

export function rowToEvent(row: Record<string, unknown>): TelemetryTimelineEvent {
  return {
    id: row.id as string,
    timestamp: row.timestamp as number,
    eventType: row.event_type as string,
    summary: row.summary as string,
    data: row.data as string | undefined,
    durationMs: row.duration_ms as number | undefined
  };
}

/**
 * 从 RendererBundleStatus 构建待插入的 attempt 记录（纯映射，无 DB）。
 * status.lastAttempt 缺失时返回 null。
 */
export function buildRendererBundleAttemptRecord(
  status: RendererBundleStatus,
): TelemetryRendererBundleAttempt | null {
  if (!status.lastAttempt) return null;
  const attempt = status.lastAttempt;
  const manifest = attempt.manifest;
  const source = status.source;
  const active = status.activeBundle;
  return {
    id: randomUUID(),
    checkedAt: parseTelemetryTimestamp(attempt.checkedAt),
    manifestUrl: attempt.manifestUrl,
    sourceChannel: source?.channel ?? null,
    sourceManifestUrlOverride: source?.manifestUrlOverride === true,
    sourceErrorReason: source?.errorReason ?? null,
    sourceErrorMessage: source?.errorMessage ?? null,
    sourceErrorTarget: source?.errorTarget ?? null,
    currentShellVersion: attempt.currentShellVersion,
    activeVersion: active?.version ?? null,
    activeContentHash: active?.contentHash ?? null,
    outcome: attempt.outcome,
    reason: attempt.reason ?? null,
    manifestVersion: manifest?.version ?? null,
    manifestContentHash: manifest?.contentHash ?? null,
    manifestMinShellVersion: manifest?.minShellVersion ?? null,
    manifestBundleUrl: manifest?.bundleUrl ?? null,
    requiredShellCapabilitiesCount: manifest?.requiredShellCapabilitiesCount ?? 0,
    rollbackToBuiltin: manifest?.rollbackToBuiltin === true,
    rollbackReason: manifest?.rollbackReason ?? null,
    missingShellCapabilities: attempt.missingShellCapabilities ?? [],
    missingRuntimeAssets: attempt.missingRuntimeAssets ?? [],
    missingResources: attempt.missingResources ?? [],
    diagnostics: attempt.diagnostics ?? [],
    errorMessage: attempt.errorMessage ?? null,
    syncedAt: null,
  };
}

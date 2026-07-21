// ============================================================================
// Telemetry Collector internal helpers/types
// 从 telemetryCollector.ts 抽出的纯函数 + 类型定义（无 `this`），以保持该模块在
// eslint max-lines 预算内。行为零变化，仅做机械搬移。
// ============================================================================

import type { TelemetryModelCall, TelemetryToolCall, ErrorCategory } from '../../shared/contract/telemetry';
import type { AgentEvent } from '../../shared/contract';
import { TELEMETRY_TRUNCATION } from '../../shared/constants';
import { sanitizeBrowserComputerToolArguments } from '../../shared/utils/browserComputerRedaction';
import { projectSurfaceExecutionMetadataForExport } from '../../shared/utils/surfaceExecutionExportProjection';
import { redactSurfaceExecutionValue } from '../../shared/utils/surfaceExecutionRedaction';

// ----------------------------------------------------------------------------
// Error Classification
// ----------------------------------------------------------------------------

/**
 * 剥离 error 字符串中混入的工具/系统日志，只对"主 error message"做分类。
 *
 * 例如 Browser 工具失败时 error 形如：
 *   "Cannot find package 'playwright' ...
 *    --- Recent Logs ---
 *    [01:16:17] [DEBUG] ..."
 * 整段一起做 substring 匹配，日志里的 "rate"/"429"/"timeout" 等噪音字串很容易
 * 误命中 rate_limit/timeout 等分类。
 */
function stripLogNoise(errorMessage: string): string {
  // 常见日志分隔符
  const markers = ['\n--- Recent Logs ---', '\n--- Logs ---', '\nRecent logs:', '\n[STDOUT]', '\n[STDERR]'];
  let cleaned = errorMessage;
  for (const m of markers) {
    const idx = cleaned.indexOf(m);
    if (idx > 0) cleaned = cleaned.slice(0, idx);
  }
  return cleaned.trim();
}

export function classifyError(errorMessage: string): ErrorCategory {
  // 剥离日志噪音，避免日志里偶现的 "rate"/"429"/"timeout" 字串误判
  const cleaned = stripLogNoise(errorMessage);
  const msg = cleaned.toLowerCase();

  // 1. 结构化信号：缺包（最常见的"系统配置"问题）
  if (msg.includes('cannot find package') || msg.includes('cannot find module') || msg.includes('module not found') || msg.includes('command not found')) {
    return 'dependency_missing';
  }

  // 2. 文件系统
  if (msg.includes('enoent') || msg.includes('no such file')) return 'file_not_found';
  if (msg.includes('eacces') || msg.includes('permission denied')) return 'permission_denied';

  // 3. 沙箱
  if (msg.includes('denied by sandbox') || msg.includes('sandbox denied') || msg.includes('sandbox: denied')) {
    return 'sandbox_denied';
  }

  // 4. 网络/HTTP — 优先匹配明确状态码（429 单独走 rate_limit）
  if (/\bhttp\s*429\b/i.test(cleaned) || /\b429\s+too many requests\b/i.test(cleaned) || msg.includes('rate limit') || (msg.includes('quota') && msg.includes('exceeded'))) {
    return 'rate_limit';
  }
  if (/\bhttp\s*40[13]\b/i.test(cleaned) || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('authentication failed')) {
    return 'auth_failed';
  }
  if (/\bhttp\s*4\d\d\b/i.test(cleaned)) return 'http_4xx';
  if (/\bhttp\s*5\d\d\b/i.test(cleaned)) return 'http_5xx';

  if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('enotfound') || msg.includes('fetch failed') || msg.includes('network is unreachable')) {
    return 'network_error';
  }

  // 5. 上下文/解析
  if (msg.includes('context length') || msg.includes('token limit') || msg.includes('maximum context')) return 'context_overflow';
  if (msg.includes('tool-args-validation-error') || msg.includes('参数校验失败')) return 'tool_args_validation';
  if (msg.includes('syntaxerror') || msg.includes('parse error') || msg.includes('unexpected token')) return 'syntax_error';

  // 6. 时间/编辑/Shell
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('not unique') || msg.includes('multiple matches')) return 'edit_not_unique';
  if (msg.includes('exit code') || msg.includes('command failed')) return 'command_failure';

  // 7. path hallucination — "does not exist" 带文件路径模式
  if (msg.includes('does not exist') && /[/\\][\w.-]+/.test(cleaned)) return 'path_hallucination';

  return 'unknown';
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SessionConfig {
  title: string;
  userId?: string | null;
  modelProvider: string;
  modelName: string;
  workingDirectory: string;
  agentVersion?: string;
  promptVersion?: string;
  toolSchemaVersion?: string;
}

export interface PendingToolCall {
  id: string;
  toolCallId: string;
  name: string;
  arguments: string;
  actualArguments?: string;
  rawArguments?: Record<string, unknown>;
  timestamp: number;
  index: number;
  parallel: boolean;
}

export interface DetachedToolCallInput {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  resultSummary?: string;
  success: boolean;
  error?: string;
  durationMs: number;
  timestamp: number;
  index: number;
  parallel?: boolean;
  metadata?: Record<string, unknown>;
}

export interface DetachedTimelineEventInput {
  eventType: string;
  summary: string;
  data?: Record<string, unknown> | string;
  durationMs?: number;
  timestamp?: number;
}

export interface DetachedTurnInput {
  sessionId: string;
  turnId: string;
  turnNumber: number;
  userPrompt: string;
  assistantResponse: string;
  thinking?: string;
  systemPromptHash?: string;
  agentId?: string;
  parentTurnId?: string;
  startTime: number;
  endTime: number;
  modelCalls?: TelemetryModelCall[];
  toolCalls?: DetachedToolCallInput[];
  events?: DetachedTimelineEventInput[];
}

export interface DetachedTurnBuffer {
  sessionId: string;
  turnId: string;
  turnNumber: number;
  userPrompt: string;
  agentId?: string;
  parentTurnId?: string;
  startTime: number;
  modelCalls: TelemetryModelCall[];
  toolCalls: DetachedToolCallInput[];
  events: DetachedTimelineEventInput[];
  pendingToolCalls: Map<string, PendingToolCall>;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function extractComputerSurfaceFields(name: string, argsJson: string, metadata?: Record<string, unknown>): Partial<TelemetryToolCall> {
  if (name !== 'computer_use') {
    return {};
  }
  const safeMetadata = metadata || {};
  const trace = isRecord(safeMetadata.workbenchTrace) ? safeMetadata.workbenchTrace : {};
  const axQuality = isRecord(safeMetadata.axQuality) ? safeMetadata.axQuality : isRecord(trace.axQuality) ? trace.axQuality : {};
  let parsedArgs: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsJson);
    if (isRecord(parsed)) {
      parsedArgs = parsed;
    }
  } catch {
    parsedArgs = {};
  }
  return {
    computerSurfaceFailureKind: asString(safeMetadata.failureKind) || asString(trace.failureKind),
    computerSurfaceMode: asString(safeMetadata.computerSurfaceMode) || asString(trace.mode),
    computerSurfaceTargetApp: asString(safeMetadata.targetApp) || asString(trace.targetApp) || asString(parsedArgs.targetApp),
    computerSurfaceAction: asString(trace.action) || asString(parsedArgs.action),
    computerSurfaceAxQualityScore: asNumber(axQuality.score),
    computerSurfaceAxQualityGrade: asString(axQuality.grade)
  };
}

export function sanitizeToolArgsForTelemetry(
  name: string,
  args: unknown
): {
  serialized: string;
  actualArguments?: string;
  rawArguments?: Record<string, unknown>;
} {
  if (!isRecord(args)) {
    const serialized = JSON.stringify(args ?? {});
    return { serialized, actualArguments: serialized };
  }
  const safeArgs = sanitizeBrowserComputerToolArguments(name, args) || args;
  const serialized = JSON.stringify(safeArgs);
  return {
    serialized,
    actualArguments: serialized,
    rawArguments: args
  };
}

export function parseSerializedArguments(serialized: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------------------
// Event summarization（从 TelemetryCollector 抽出的纯函数，无 `this`）
// ----------------------------------------------------------------------------

export function summarizeEvent(event: AgentEvent): string {
  const data = event.data as Record<string, unknown> | undefined;
  switch (event.type) {
    case 'turn_start':
      return `Turn ${data?.iteration ?? '?'} started`;
    case 'turn_end':
      return `Turn ended`;
    case 'tool_schema_snapshot':
      return `${Number(data?.toolCount ?? 0)} tool schemas available`;
    case 'model_decision':
      return `Model decision: ${String(data?.requestedProvider ?? '?')}/${String(data?.requestedModel ?? '?')} -> ${String(data?.resolvedProvider ?? '?')}/${String(data?.resolvedModel ?? '?')} (${String(data?.reason ?? 'unknown')})`;
    case 'artifact_locator':
      return `Artifact locator ${String(data?.state ?? 'unknown')}: ${String(data?.kind ?? 'unknown')}/${String(data?.reason ?? 'unknown')}`;
    case 'tool_call_start':
      return `Tool: ${data?.name ?? 'unknown'} started`;
    case 'tool_call_end':
      return `Tool completed: ${(data as { success?: boolean })?.success ? 'success' : 'failed'}`;
    case 'message':
      return `Message: ${((data as { content?: string })?.content ?? '').substring(0, 80)}`;
    case 'error':
      return `Error: ${(data as { message?: string })?.message?.substring(0, 100) ?? 'unknown'}`;
    case 'notification':
      return `Notification: ${(data as { message?: string })?.message?.substring(0, 100) ?? ''}`;
    case 'context_compressed':
      return `Context compaction triggered`;
    case 'message_delta':
      return data?.path === 'reasoning' ? `Thinking...` : `Streaming response...`;
    case 'stream_reasoning':
      return `Thinking...`;
    default:
      return `Event: ${event.type}`;
  }
}

export function extractEventData(event: AgentEvent): string | undefined {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data) return undefined;

  if (event.type === 'tool_schema_snapshot') {
    return JSON.stringify({
      turnId: data.turnId,
      toolCount: data.toolCount,
      tools: data.tools,
    });
  }

  if (event.type === 'model_decision') {
    const extracted: Record<string, unknown> = {};
    for (const key of [
      'turnId',
      'timestamp',
      'requestedProvider',
      'requestedModel',
      'resolvedProvider',
      'resolvedModel',
      'reason',
      'billingMode',
      'fallbackFrom',
      'role',
    ]) {
      if (key in data) {
        extracted[key] = data[key];
      }
    }
    return JSON.stringify(extracted);
  }

  if (event.type === 'artifact_locator') {
    return JSON.stringify({
      state: data.state,
      kind: data.kind,
      reason: data.reason,
    });
  }

  if (event.type === 'tool_call_end') {
    const metadata = data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
      ? data.metadata as Record<string, unknown>
      : undefined;
    const extracted: Record<string, unknown> = {};
    for (const key of ['toolCallId', 'success', 'error', 'duration']) {
      if (key in data) {
        const val = data[key];
        extracted[key] = typeof val === 'string'
          ? String(redactSurfaceExecutionValue(val, key)).substring(0, TELEMETRY_TRUNCATION.EVENT_SUMMARY)
          : val;
      }
    }
    const safeMetadata: Record<string, unknown> = {};
    if (metadata?.validationFailed === true) {
      Object.assign(safeMetadata, {
        validationFailed: true,
        validationIssues: Array.isArray(metadata.validationIssues)
          ? metadata.validationIssues
          : undefined,
      });
    }
    const surfaceExecutionExportV1 = projectSurfaceExecutionMetadataForExport(metadata, {
      toolCallId: typeof data.toolCallId === 'string' ? data.toolCallId : undefined,
      success: typeof data.success === 'boolean' ? data.success : undefined,
      error: typeof data.error === 'string' ? data.error : undefined,
    });
    if (surfaceExecutionExportV1) {
      safeMetadata.surfaceExecutionExportV1 = surfaceExecutionExportV1;
    }
    if (Object.keys(safeMetadata).length > 0) {
      extracted.metadata = safeMetadata;
    }
    return Object.keys(extracted).length > 0 ? JSON.stringify(extracted) : undefined;
  }

  // Extract only key fields, exclude large content
  const extracted: Record<string, unknown> = {};
  const allowedKeys = ['turnId', 'iteration', 'name', 'toolCallId', 'success', 'error', 'code', 'message', 'duration'];
  for (const key of allowedKeys) {
    if (key in data) {
      const val = data[key];
      if (typeof val === 'string') {
        extracted[key] = val.substring(0, TELEMETRY_TRUNCATION.EVENT_SUMMARY);
      } else {
        extracted[key] = val;
      }
    }
  }

  if (Object.keys(extracted).length === 0) return undefined;
  return JSON.stringify(extracted);
}

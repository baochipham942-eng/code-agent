// ============================================================================
// Telemetry Service — 可观测性基础设施
//
// 轻量级 span 追踪服务，兼容 OpenTelemetry 数据模型但无外部依赖。
// 提供 span 创建/管理、指标聚合、ring buffer 存储。
// ============================================================================

import crypto from 'crypto';
import { redactCredentialText } from '../../shared/security/secretPatterns';
import { createLogger } from '../services/infra/logger';
import {
  createChildRunTraceContext,
  getActiveRunTraceContext,
  withRunTraceContext,
  type RunTraceContext,
} from './runTraceContext';

const logger = createLogger('Telemetry');

// ── Span 类型 ───────────────────────────────────────────────────────────

export type SpanKind = 'internal' | 'run' | 'turn' | 'tool' | 'agent' | 'approval' | 'hook' | 'mcp' | 'model' | 'workflow' | 'bridge';
export type SpanStatus = 'ok' | 'error' | 'cancelled';

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, string | number>;
}

export interface TelemetrySpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

// ── 聚合指标 ─────────────────────────────────────────────────────────────

export interface TelemetryMetrics {
  toolCallCount: number;
  toolCallErrors: number;
  toolCallTotalDurationMs: number;
  agentSpawnCount: number;
  agentCompletedCount: number;
  agentFailedCount: number;
  hookExecutionCount: number;
  hookBlockCount: number;
  mcpCallCount: number;
  mcpErrorCount: number;
  modelInferenceCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

// ── OTel-compatible 导出格式 ─────────────────────────────────────────────

interface OTelExportSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  kind: number; // 1=INTERNAL, 2=TOOL, etc.
  status: { code: number; message?: string };
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }>;
  events: Array<{ name: string; timeUnixNano: string; attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: string } }> }>;
}

// SpanKind -> OTel kind code mapping
const SPAN_KIND_CODE: Record<SpanKind, number> = {
  internal: 0,
  run: 0,
  turn: 0,
  tool: 0,
  agent: 0,
  approval: 0,
  hook: 0,
  mcp: 2,
  model: 2,
  workflow: 0,
  bridge: 2,
};

// SpanStatus -> OTel status code mapping
const STATUS_CODE: Record<SpanStatus, number> = {
  ok: 1,
  error: 2,
  cancelled: 2,
};

// ── Ring Buffer ──────────────────────────────────────────────────────────

const MAX_COMPLETED_SPANS = 500;

const SENSITIVE_ATTRIBUTE_KEY = /(^|[._-])(authorization|cookie|api[-_]?key|token|secret|credential|password|prompt|argument|arguments|args|input|output|reasoning)$/i;

function createTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function createSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeSpanAttributes(
  attributes: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(attributes)
    .filter(([key]) => !SENSITIVE_ATTRIBUTE_KEY.test(key))
    .map(([key, value]) => [key, typeof value === 'string' ? redactCredentialText(value) : value]));
}

// ── TelemetryService ─────────────────────────────────────────────────────

export class TelemetryService {
  private static instance: TelemetryService | null = null;

  // Active spans indexed by spanId
  private activeSpans = new Map<string, TelemetrySpan>();

  // Ring buffer for completed spans
  private completedSpans: TelemetrySpan[] = [];
  private ringIndex = 0;
  private totalCompleted = 0;

  // Aggregated metrics
  private metrics: TelemetryMetrics = {
    toolCallCount: 0,
    toolCallErrors: 0,
    toolCallTotalDurationMs: 0,
    agentSpawnCount: 0,
    agentCompletedCount: 0,
    agentFailedCount: 0,
    hookExecutionCount: 0,
    hookBlockCount: 0,
    mcpCallCount: 0,
    mcpErrorCount: 0,
    modelInferenceCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  static getInstance(): TelemetryService {
    if (!this.instance) {
      this.instance = new TelemetryService();
    }
    return this.instance;
  }

  // --------------------------------------------------------------------------
  // Trace 管理
  // --------------------------------------------------------------------------

  /** Legacy compatibility: returns an isolated trace id and never mutates run authority. */
  newTrace(): string {
    return createTraceId();
  }

  getTraceId(): string {
    return getActiveRunTraceContext()?.traceId ?? createTraceId();
  }

  // --------------------------------------------------------------------------
  // 通用 Span 操作
  // --------------------------------------------------------------------------

  startSpan(
    name: string,
    kind: SpanKind,
    attributes: Record<string, string | number | boolean> = {},
    parentSpanId?: string,
    runTraceContext?: RunTraceContext,
  ): TelemetrySpan {
    const activeRunContext = runTraceContext ?? getActiveRunTraceContext();
    const parentSpan = parentSpanId ? this.activeSpans.get(parentSpanId) : undefined;
    const spanId = runTraceContext && !this.activeSpans.has(runTraceContext.spanId)
      ? runTraceContext.spanId
      : createSpanId();
    const resolvedParentSpanId = parentSpanId
      ?? (activeRunContext?.spanId !== spanId ? activeRunContext?.spanId : undefined);
    const runAttributes: Record<string, string | number | boolean> = activeRunContext
      ? {
          'run.id': activeRunContext.runId,
          'session.id': activeRunContext.sessionId,
          'run.attempt': activeRunContext.attempt,
          'run.owner_epoch': activeRunContext.ownerEpoch,
          'run.engine': activeRunContext.engine,
          'run.process_instance_id': activeRunContext.processInstanceId,
          'workspace.fingerprint': activeRunContext.workspaceFingerprint,
          ...(activeRunContext.agentId ? { 'agent.id': activeRunContext.agentId } : {}),
          ...(activeRunContext.parentRunId ? { 'run.parent_id': activeRunContext.parentRunId } : {}),
        }
      : {};
    const span: TelemetrySpan = {
      traceId: parentSpan?.traceId ?? activeRunContext?.traceId ?? createTraceId(),
      spanId,
      parentSpanId: resolvedParentSpanId,
      name,
      kind,
      startTime: Date.now(),
      status: 'ok',
      attributes: sanitizeSpanAttributes({ ...runAttributes, ...attributes }),
      events: [],
    };

    this.activeSpans.set(span.spanId, span);
    return span;
  }

  startRunAttemptSpan(runTraceContext: RunTraceContext, attributes: Record<string, string | number | boolean> = {}): TelemetrySpan {
    return this.startSpan(`run attempt ${runTraceContext.attempt}`, 'run', {
      'run.id': runTraceContext.runId,
      'session.id': runTraceContext.sessionId,
      'run.attempt': runTraceContext.attempt,
      'run.owner_epoch': runTraceContext.ownerEpoch,
      'run.engine': runTraceContext.engine,
      'run.process_instance_id': runTraceContext.processInstanceId,
      'workspace.fingerprint': runTraceContext.workspaceFingerprint,
      ...(runTraceContext.agentId ? { 'agent.id': runTraceContext.agentId } : {}),
      ...(runTraceContext.parentRunId ? { 'run.parent_id': runTraceContext.parentRunId } : {}),
      ...attributes,
    }, undefined, runTraceContext);
  }

  updateSpan(spanId: string, attributes: Record<string, string | number | boolean>): void {
    const span = this.activeSpans.get(spanId);
    if (span) Object.assign(span.attributes, sanitizeSpanAttributes(attributes));
  }

  findActiveSpanByAttribute(key: string, value: string): TelemetrySpan | undefined {
    return [...this.activeSpans.values()].find((span) => span.attributes[key] === value);
  }

  endOpenSpansForTrace(
    traceId: string,
    status: SpanStatus,
    excludeSpanId?: string,
  ): void {
    const spanIds = [...this.activeSpans.values()]
      .filter((span) => span.traceId === traceId && span.spanId !== excludeSpanId)
      .map((span) => span.spanId);
    for (const spanId of spanIds) {
      this.endSpan(spanId, status, { 'terminal.status': 'run_ended' });
    }
  }

  /** End a span, move it to the ring buffer, update metrics */
  endSpan(
    spanId: string,
    status: SpanStatus = 'ok',
    attributes?: Record<string, string | number | boolean>,
  ): TelemetrySpan | undefined {
    const span = this.activeSpans.get(spanId);
    if (!span) {
      logger.warn(`endSpan: span not found: ${spanId}`);
      return undefined;
    }

    span.endTime = Date.now();
    span.status = status;
    if (attributes) {
      Object.assign(span.attributes, sanitizeSpanAttributes(attributes));
    }

    this.activeSpans.delete(spanId);
    this.pushToRingBuffer(span);
    this.updateMetrics(span);

    return span;
  }

  /** Add an event to an active span */
  addSpanEvent(
    spanId: string,
    eventName: string,
    attributes?: Record<string, string | number>,
  ): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.events.push({
      name: eventName,
      timestamp: Date.now(),
      attributes: attributes
        ? sanitizeSpanAttributes(attributes) as Record<string, string | number>
        : undefined,
    });
  }

  // --------------------------------------------------------------------------
  // 便捷方法 — Tool Span
  // --------------------------------------------------------------------------

  startToolSpan(
    toolName: string,
    _args?: Record<string, unknown>,
    parentSpanId?: string,
    runTraceContext?: RunTraceContext,
  ): TelemetrySpan {
    this.metrics.toolCallCount++;
    const attrs: Record<string, string | number | boolean> = {
      'tool.name': toolName,
    };
    return this.startSpan(`tool:${toolName}`, 'tool', attrs, parentSpanId, runTraceContext);
  }

  // --------------------------------------------------------------------------
  // 便捷方法 — Agent Span
  // --------------------------------------------------------------------------

  startAgentSpan(
    agentId: string,
    agentType: string,
    _task?: string,
    parentSpanId?: string,
    runTraceContext?: RunTraceContext,
  ): TelemetrySpan {
    this.metrics.agentSpawnCount++;
    return this.startSpan(`agent:${agentType}`, agentType === 'turn' ? 'turn' : 'agent', {
      'agent.id': agentId,
      'agent.type': agentType,
    }, parentSpanId, runTraceContext);
  }

  // --------------------------------------------------------------------------
  // 便捷方法 — Hook Span
  // --------------------------------------------------------------------------

  startHookSpan(
    hookEvent: string,
    hookType: string,
    parentSpanId?: string,
  ): TelemetrySpan {
    this.metrics.hookExecutionCount++;
    return this.startSpan(`hook:${hookEvent}`, 'hook', {
      'hook.event': hookEvent,
      'hook.type': hookType,
    }, parentSpanId);
  }

  // --------------------------------------------------------------------------
  // 便捷方法 — MCP Span
  // --------------------------------------------------------------------------

  startMcpSpan(
    serverName: string,
    toolName: string,
    parentSpanId?: string,
  ): TelemetrySpan {
    this.metrics.mcpCallCount++;
    return this.startSpan(`mcp:${serverName}/${toolName}`, 'mcp', {
      'mcp.server': serverName,
      'mcp.tool': toolName,
    }, parentSpanId);
  }

  // --------------------------------------------------------------------------
  // 便捷方法 — Model Span
  // --------------------------------------------------------------------------

  startModelSpan(
    model: string,
    provider: string,
    parentSpanId?: string,
  ): TelemetrySpan {
    this.metrics.modelInferenceCount++;
    return this.startSpan(`model:${provider}/${model}`, 'model', {
      'model.name': model,
      'model.provider': provider,
    }, parentSpanId);
  }

  // --------------------------------------------------------------------------
  // 指标查询
  // --------------------------------------------------------------------------

  getMetrics(): Readonly<TelemetryMetrics> {
    return { ...this.metrics };
  }

  /** Record token usage (called externally when model response arrives) */
  recordTokens(inputTokens: number, outputTokens: number): void {
    this.metrics.totalInputTokens += inputTokens;
    this.metrics.totalOutputTokens += outputTokens;
  }

  // --------------------------------------------------------------------------
  // Span 查询
  // --------------------------------------------------------------------------

  /** Get the N most recent completed spans */
  getRecentSpans(limit: number = 50): TelemetrySpan[] {
    const total = Math.min(this.totalCompleted, MAX_COMPLETED_SPANS);
    const count = Math.min(limit, total);
    const result: TelemetrySpan[] = [];

    // Walk backwards from the most recently inserted
    for (let i = 0; i < count; i++) {
      const idx = (this.ringIndex - 1 - i + MAX_COMPLETED_SPANS) % MAX_COMPLETED_SPANS;
      const span = this.completedSpans[idx];
      if (span) {
        result.push(span);
      }
    }

    return result;
  }

  /** Get all active (in-flight) spans */
  getActiveSpans(): TelemetrySpan[] {
    return Array.from(this.activeSpans.values());
  }

  // --------------------------------------------------------------------------
  // 导出 — OTel-compatible JSON
  // --------------------------------------------------------------------------

  exportSpans(): string {
    const allSpans = [
      ...this.getRecentSpans(MAX_COMPLETED_SPANS),
      ...this.getActiveSpans(),
    ];

    const otelSpans: OTelExportSpan[] = allSpans.map(span => ({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      operationName: span.name,
      startTimeUnixNano: String(span.startTime * 1_000_000),
      endTimeUnixNano: span.endTime ? String(span.endTime * 1_000_000) : undefined,
      kind: SPAN_KIND_CODE[span.kind],
      status: {
        code: STATUS_CODE[span.status],
        message: span.status === 'error' ? (span.attributes['error.message'] as string) : undefined,
      },
      attributes: Object.entries(span.attributes).map(([key, value]) => ({
        key,
        value: typeof value === 'string'
          ? { stringValue: value }
          : typeof value === 'boolean'
            ? { boolValue: value }
            : { intValue: String(value) },
      })),
      events: span.events.map(evt => ({
        name: evt.name,
        timeUnixNano: String(evt.timestamp * 1_000_000),
        attributes: evt.attributes
          ? Object.entries(evt.attributes).map(([key, value]) => ({
              key,
              value: typeof value === 'string'
                ? { stringValue: value }
                : { intValue: String(value) },
            }))
          : undefined,
      })),
    }));

    return JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'code-agent' } }] },
        scopeSpans: [{
          scope: { name: 'code-agent-telemetry', version: '1.0.0' },
          spans: otelSpans,
        }],
      }],
    }, null, 2);
  }

  // --------------------------------------------------------------------------
  // 重置（测试用）
  // --------------------------------------------------------------------------

  reset(): void {
    this.activeSpans.clear();
    this.completedSpans = [];
    this.ringIndex = 0;
    this.totalCompleted = 0;
    this.metrics = {
      toolCallCount: 0,
      toolCallErrors: 0,
      toolCallTotalDurationMs: 0,
      agentSpawnCount: 0,
      agentCompletedCount: 0,
      agentFailedCount: 0,
      hookExecutionCount: 0,
      hookBlockCount: 0,
      mcpCallCount: 0,
      mcpErrorCount: 0,
      modelInferenceCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
  }

  // --------------------------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------------------------

  private pushToRingBuffer(span: TelemetrySpan): void {
    if (this.completedSpans.length < MAX_COMPLETED_SPANS) {
      this.completedSpans.push(span);
    } else {
      this.completedSpans[this.ringIndex] = span;
    }
    this.ringIndex = (this.ringIndex + 1) % MAX_COMPLETED_SPANS;
    this.totalCompleted++;
  }

  private updateMetrics(span: TelemetrySpan): void {
    const durationMs = (span.endTime ?? span.startTime) - span.startTime;

    switch (span.kind) {
      case 'tool':
        this.metrics.toolCallTotalDurationMs += durationMs;
        if (span.status === 'error') {
          this.metrics.toolCallErrors++;
        }
        break;

      case 'agent':
        if (span.status === 'error') {
          this.metrics.agentFailedCount++;
        } else {
          this.metrics.agentCompletedCount++;
        }
        break;

      case 'hook':
        if (span.attributes['hook.blocked'] === true) {
          this.metrics.hookBlockCount++;
        }
        break;

      case 'mcp':
        if (span.status === 'error') {
          this.metrics.mcpErrorCount++;
        }
        break;

      case 'model': {
        const inputTokens = span.attributes['model.input_tokens'];
        const outputTokens = span.attributes['model.output_tokens'];
        if (typeof inputTokens === 'number') {
          this.metrics.totalInputTokens += inputTokens;
        }
        if (typeof outputTokens === 'number') {
          this.metrics.totalOutputTokens += outputTokens;
        }
        break;
      }
    }
  }
}

// ── 单例导出 ─────────────────────────────────────────────────────────────

export function getTelemetryService(): TelemetryService {
  return TelemetryService.getInstance();
}

export async function withApprovalTrace<T>(
  approvalKind: string,
  callback: () => Promise<T>,
): Promise<T> {
  const parent = getActiveRunTraceContext();
  if (!parent) return callback();
  const child = createChildRunTraceContext(parent);
  let spanId: string | undefined;
  try {
    spanId = getTelemetryService().startSpan(
      `approval:${approvalKind}`,
      'approval',
      { 'approval.kind': approvalKind, 'approval.state': 'waiting' },
      parent.spanId,
      child,
    ).spanId;
    getTelemetryService().addSpanEvent(spanId, 'approval.waiting');
  } catch {
    // Approval behavior is independent from tracing availability.
  }

  return withRunTraceContext(child, async () => {
    try {
      const result = await callback();
      if (spanId) {
        const approved = Boolean(result && typeof result === 'object' && 'approved' in result
          ? (result as { approved?: unknown }).approved
          : true);
        try {
          getTelemetryService().addSpanEvent(spanId, approved ? 'approval.resolved' : 'approval.rejected');
          getTelemetryService().endSpan(spanId, approved ? 'ok' : 'cancelled', {
            'approval.state': approved ? 'resolved' : 'rejected',
          });
        } catch {
          // Approval behavior is independent from tracing availability.
        }
      }
      return result;
    } catch (error) {
      if (spanId) {
        try {
          getTelemetryService().endSpan(spanId, 'error', { 'approval.state': 'failed' });
        } catch {
          // Approval behavior is independent from tracing availability.
        }
      }
      throw error;
    }
  });
}

// ============================================================================
// Telemetry Adapter — 桥接 TelemetryAdapter 接口与 TelemetryService
//
// 将现有的 TelemetryAdapter 事件（turn/model/tool）映射为 TelemetryService
// 的 span 操作，实现 turn-based 采集与 span-based 追踪的统一。
// ============================================================================

import type { TelemetryAdapter, TelemetryModelCall } from '../../shared/types/telemetry';
import { getTelemetryService } from './telemetryService';
import type { TelemetryService } from './telemetryService';

// ── 工厂函数 ─────────────────────────────────────────────────────────────

/**
 * Create a TelemetryAdapter that bridges the existing TelemetryAdapter interface
 * to the span-based TelemetryService.
 *
 * Each tool call, model inference, and turn creates a corresponding span.
 */
export function createTelemetryAdapter(
  service?: TelemetryService,
): TelemetryAdapter {
  const svc = service ?? getTelemetryService();

  // Track active span IDs for correlation
  const turnSpans = new Map<string, string>();        // turnId -> spanId
  const toolCallSpans = new Map<string, string>();    // toolCallId -> spanId
  const modelCallSpans = new Map<string, string>();   // turnId -> latest model spanId

  return {
    onTurnStart(turnId: string, turnNumber: number, userPrompt: string, parentTurnId?: string): void {
      const parentSpanId = parentTurnId ? turnSpans.get(parentTurnId) : undefined;
      const span = svc.startAgentSpan(
        turnId,
        'turn',
        userPrompt || `Turn #${turnNumber}`,
        parentSpanId,
      );
      turnSpans.set(turnId, span.spanId);
    },

    onModelCall(turnId: string, call: TelemetryModelCall): void {
      const parentSpanId = turnSpans.get(turnId);
      const span = svc.startModelSpan(call.model, call.provider, parentSpanId);

      // Record token usage on the span
      span.attributes['model.input_tokens'] = call.inputTokens;
      span.attributes['model.output_tokens'] = call.outputTokens;
      span.attributes['model.latency_ms'] = call.latencyMs;
      span.attributes['model.response_type'] = call.responseType;
      span.attributes['model.tool_call_count'] = call.toolCallCount;
      if (call.truncated) {
        span.attributes['model.truncated'] = true;
      }
      if (call.error) {
        span.attributes['error.message'] = call.error;
      }
      if (call.fallbackUsed) {
        span.attributes['model.fallback_from'] = call.fallbackUsed.from;
        span.attributes['model.fallback_to'] = call.fallbackUsed.to;
        span.attributes['model.fallback_reason'] = call.fallbackUsed.reason;
      }

      modelCallSpans.set(turnId, span.spanId);

      // End immediately — model call is reported after completion
      svc.endSpan(
        span.spanId,
        call.error ? 'error' : 'ok',
      );

      // Record tokens in aggregated metrics
      svc.recordTokens(call.inputTokens, call.outputTokens);
    },

    onToolCallStart(turnId: string, toolCallId: string, name: string, args: unknown, _index: number, parallel: boolean): void {
      const parentSpanId = turnSpans.get(turnId);
      const span = svc.startToolSpan(
        name,
        args as Record<string, unknown> | undefined,
        parentSpanId,
      );
      span.attributes['tool.parallel'] = parallel;
      span.attributes['tool.call_id'] = toolCallId;
      toolCallSpans.set(toolCallId, span.spanId);
    },

    onToolCallEnd(turnId: string, toolCallId: string, success: boolean, error: string | undefined, durationMs: number, output: string | undefined): void {
      const spanId = toolCallSpans.get(toolCallId);
      if (!spanId) return;
      toolCallSpans.delete(toolCallId);

      const extraAttrs: Record<string, string | number | boolean> = {
        'tool.duration_ms': durationMs,
        'tool.success': success,
      };
      if (error) {
        extraAttrs['error.message'] = error.length > 256 ? error.substring(0, 256) + '...' : error;
      }
      if (output) {
        extraAttrs['tool.output_size'] = output.length;
      }

      svc.endSpan(spanId, success ? 'ok' : 'error', extraAttrs);
    },

    onTurnEnd(turnId: string, assistantResponse: string, thinking?: string, systemPromptHash?: string): void {
      const spanId = turnSpans.get(turnId);
      if (!spanId) return;
      turnSpans.delete(turnId);

      const extraAttrs: Record<string, string | number | boolean> = {
        'turn.response_length': assistantResponse.length,
      };
      if (thinking) {
        extraAttrs['turn.has_thinking'] = true;
      }
      if (systemPromptHash) {
        extraAttrs['turn.system_prompt_hash'] = systemPromptHash;
      }

      svc.endSpan(spanId, 'ok', extraAttrs);
    },
  };
}

// ── Standalone span helpers（不经过 TelemetryAdapter 接口的直接调用） ────

/**
 * Record a hook execution as a span. Call sites: hookManager.
 */
export function recordHookSpan(
  hookEvent: string,
  hookType: string,
  durationMs: number,
  blocked: boolean,
  service?: TelemetryService,
): void {
  const svc = service ?? getTelemetryService();
  const span = svc.startHookSpan(hookEvent, hookType);
  span.attributes['hook.blocked'] = blocked;
  span.attributes['hook.duration_ms'] = durationMs;
  svc.endSpan(span.spanId, blocked ? 'cancelled' : 'ok');
}

/**
 * Record an MCP call as a span. Call sites: mcpManager.
 */
export function recordMcpSpan(
  serverName: string,
  toolName: string,
  durationMs: number,
  success: boolean,
  error?: string,
  service?: TelemetryService,
): void {
  const svc = service ?? getTelemetryService();
  const span = svc.startMcpSpan(serverName, toolName);
  span.attributes['mcp.duration_ms'] = durationMs;
  if (error) {
    span.attributes['error.message'] = error.length > 256 ? error.substring(0, 256) + '...' : error;
  }
  svc.endSpan(span.spanId, success ? 'ok' : 'error');
}

// N-MAXLINES-MINEFIELD-2-FU1-S6 move-only extraction: the callTool tracing
// wrapper moved from mcpClient.ts. Bodies are byte-identical apart from
// `this.inProcessServers.has(serverName)` becoming the hasInProcessServer
// parameter; tracing is independent from MCP execution (fail-open preserved).
import type { ToolResult } from '../../shared/contract';
import {
  createChildRunTraceContext,
  getActiveRunTraceContext,
  type RunTraceContext,
} from '../telemetry/runTraceContext';
import { getTelemetryService } from '../telemetry/telemetryService';

export function startMcpToolCallSpan(
  toolCallId: string,
  serverName: string,
  toolName: string,
  hasInProcessServer: boolean,
): { spanId?: string; childTraceContext?: RunTraceContext } {
  const parentTraceContext = getActiveRunTraceContext();
  const childTraceContext = parentTraceContext
    ? createChildRunTraceContext(parentTraceContext)
    : undefined;
  let spanId: string | undefined;
  try {
    const parentToolSpan = getTelemetryService().findActiveSpanByAttribute('tool.call_id', toolCallId);
    spanId = getTelemetryService().startSpan(
      `mcp:${serverName}/${toolName}`,
      'mcp',
      {
        'mcp.server': serverName,
        'mcp.tool': toolName,
        'mcp.transport': hasInProcessServer ? 'in-process' : 'client',
      },
      parentToolSpan?.spanId ?? parentTraceContext?.spanId,
      childTraceContext,
    ).spanId;
  } catch {
    // MCP execution is independent from tracing availability.
  }
  return { spanId, childTraceContext };
}

export function endMcpToolSpan(spanId: string | undefined, result: ToolResult): void {
  try {
    if (spanId) {
      const cancelled = result.metadata?.cancelledByRun === true || /cancel|abort/i.test(result.error ?? '');
      getTelemetryService().endSpan(spanId, result.success ? 'ok' : cancelled ? 'cancelled' : 'error', {
        'mcp.result_status': result.success ? 'success' : cancelled ? 'cancelled' : 'failed',
        ...(result.duration !== undefined ? { 'mcp.duration_ms': result.duration } : {}),
      });
    }
  } catch {
    // MCP results are independent from tracing availability.
  }
}

export function endMcpToolSpanAsError(spanId: string | undefined): void {
  try {
    if (spanId) getTelemetryService().endSpan(spanId, 'error', { 'mcp.result_status': 'failed' });
  } catch {
    // Preserve the original MCP error.
  }
}

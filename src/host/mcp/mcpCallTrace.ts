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

/**
 * normalizeMcpToolArgs 改写了入参时在当前 MCP span 上留痕（N-CONNECTOR-POLISH-AUDIT-FU5）。
 * 静默改参正是 owner 点名要可追溯的「藏坏调用」风险：只记 server/tool 与被改的
 * **顶层键名**，绝不记值（参数可能带密钥）。引用相等 = 没改 = 不记；
 * tracing 不可用不得影响 MCP 执行（与同文件既有 helper 同口径 fail-open）。
 */
export function traceMcpArgsNormalized(
  spanId: string | undefined,
  serverName: string,
  toolName: string,
  originalArgs: Record<string, unknown>,
  normalizedArgs: Record<string, unknown>,
): void {
  try {
    if (!spanId || normalizedArgs === originalArgs) return;
    const changed = new Set<string>();
    for (const key of Object.keys(originalArgs)) {
      if (normalizedArgs[key] !== originalArgs[key]) changed.add(key);
    }
    for (const key of Object.keys(normalizedArgs)) {
      if (!(key in originalArgs)) changed.add(key);
    }
    if (changed.size === 0) return;
    getTelemetryService().addSpanEvent(spanId, 'mcp.args_normalized', {
      'mcp.server': serverName,
      'mcp.tool': toolName,
      'mcp.args_changed_keys': [...changed].sort().join(','),
    });
  } catch {
    // Args normalization tracing is independent from MCP execution.
  }
}

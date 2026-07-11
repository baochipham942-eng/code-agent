import { randomUUID } from 'node:crypto';
import type { RunContext } from '../../host/runtime/runContext';
import type {
  ToolExecutionDelegate,
} from '../../host/tools/toolExecutor';
import type { ToolExecutionResult } from '../../host/tools/types';
import { isLocalTool, mapToolName } from '../../shared/localTools';
import type { WebRouteLogger } from './routeTypes';
import { getTelemetryService } from '../../host/telemetry/telemetryService';
import {
  createChildRunTraceContext,
  getActiveRunTraceContext,
  serializeRunTraceContext,
  type RunTraceContext,
} from '../../host/telemetry/runTraceContext';

export interface PendingLocalToolCall {
  resolve: (result: ToolExecutionResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BridgeToolDispatchDeps {
  runContext: RunContext;
  pendingLocalToolCalls: Map<string, PendingLocalToolCall>;
  emitSSE: (event: string, data: unknown) => void;
  logger: WebRouteLogger;
  timeoutMs?: number;
  traceContext?: RunTraceContext;
}

const DEFAULT_LOCAL_TOOL_TIMEOUT_MS = 120_000;

function toBridgeParams(
  toolName: string,
  params: Record<string, unknown>,
  runCwd: string,
): { params: Record<string, unknown>; cwd: string } {
  const requestedBashCwd = toolName === 'Bash' || toolName === 'shell_exec'
    ? params.working_directory
    : undefined;
  const cwd = typeof requestedBashCwd === 'string' && requestedBashCwd.trim()
    ? requestedBashCwd
    : runCwd;
  const bridgeParams: Record<string, unknown> = { ...params, cwd };
  if (bridgeParams.path === undefined && bridgeParams.file_path !== undefined) {
    bridgeParams.path = bridgeParams.file_path;
  }
  return { params: bridgeParams, cwd };
}

function isBridgeUnavailable(result: ToolExecutionResult): boolean {
  return result.success === false
    && typeof result.error === 'string'
    && result.error.includes('Bridge is not connected');
}

/**
 * Final dispatch hop for BRIDGE_MODE. ToolExecutor still owns every policy,
 * permission, cache, write-isolation, checkpoint, audit, and artifact step.
 */
export function createBridgeToolDispatch(deps: BridgeToolDispatchDeps): ToolExecutionDelegate {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_LOCAL_TOOL_TIMEOUT_MS;

  return async (toolName, params, context, options) => {
    if (!isLocalTool(toolName)) return null;
    if (options.abortSignal?.aborted) {
      return { success: false, error: `Local tool '${toolName}' cancelled` };
    }

    const bridgeTool = mapToolName(toolName);
    const toolCallId = `bridge-${randomUUID()}`;
    const parentTraceContext = deps.traceContext ?? getActiveRunTraceContext();
    const bridgeTraceContext = parentTraceContext
      ? createChildRunTraceContext(parentTraceContext)
      : undefined;
    let bridgeSpanId: string | undefined;
    try {
      const parentToolSpan = options.currentToolCallId
        ? getTelemetryService().findActiveSpanByAttribute('tool.call_id', options.currentToolCallId)
        : undefined;
      bridgeSpanId = getTelemetryService().startSpan(
        `bridge:${bridgeTool}`,
        'bridge',
        {
          'bridge.tool': bridgeTool,
          'bridge.run_id': deps.runContext.runId,
          'bridge.transport': 'renderer-http',
        },
        parentToolSpan?.spanId ?? parentTraceContext?.spanId,
        bridgeTraceContext,
      ).spanId;
    } catch {
      // Bridge execution is independent from tracing availability.
    }
    const workspace = context.workspace ?? deps.runContext.workspace;
    const runCwd = context.workingDirectory || deps.runContext.cwd;
    const bound = toBridgeParams(toolName, params, runCwd);

    deps.emitSSE('tool_call_local', {
      toolCallId,
      tool: bridgeTool,
      originalTool: toolName,
      params: bound.params,
      permissionLevel: 'L1',
      runId: deps.runContext.runId,
      sessionId: deps.runContext.sessionId,
      workspace,
      cwd: bound.cwd,
      ...(bridgeTraceContext
        ? { traceContext: serializeRunTraceContext(bridgeTraceContext) }
        : {}),
    });

    const result = await new Promise<ToolExecutionResult>((resolve) => {
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        options.abortSignal?.removeEventListener('abort', onAbort);
        deps.pendingLocalToolCalls.delete(toolCallId);
      };
      const finish = (next: ToolExecutionResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(next);
      };
      const onAbort = (): void => {
        deps.emitSSE('tool_cancel_local', {
          toolCallId,
          runId: deps.runContext.runId,
          sessionId: deps.runContext.sessionId,
        });
        finish({ success: false, error: `Local tool '${toolName}' cancelled` });
      };

      const timer = setTimeout(() => {
        finish({
          success: false,
          error: `Local tool '${toolName}' timed out after ${timeoutMs / 1000}s waiting for Bridge response`,
        });
      }, timeoutMs);

      deps.pendingLocalToolCalls.set(toolCallId, {
        resolve: finish,
        reject: (error) => finish({ success: false, error: error.message }),
        timer,
      });
      options.abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (options.abortSignal?.aborted) onAbort();
    });

    if (isBridgeUnavailable(result)) {
      try {
        if (bridgeSpanId) {
          getTelemetryService().endSpan(bridgeSpanId, 'error', { 'bridge.result_status': 'unavailable' });
        }
      } catch {
        // Bridge fallback must not depend on tracing availability.
      }
      deps.logger.warn(`[BridgeProxy] Bridge down, falling back to local executor for: ${toolName}`);
      return null;
    }
    try {
      if (bridgeSpanId) {
        const cancelled = /cancel|abort/i.test(result.error ?? '');
        const timedOut = /timeout|timed out/i.test(result.error ?? '');
        getTelemetryService().endSpan(
          bridgeSpanId,
          result.success ? 'ok' : cancelled ? 'cancelled' : 'error',
          {
            'bridge.result_status': result.success ? 'success' : timedOut ? 'timeout' : cancelled ? 'cancelled' : 'failed',
          },
        );
      }
    } catch {
      // Bridge results are independent from tracing availability.
    }
    return result;
  };
}

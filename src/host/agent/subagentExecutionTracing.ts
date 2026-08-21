import { getTelemetryService } from '../telemetry/telemetryService';
import {
  createChildRunTraceContext,
  withRunTraceContext,
} from '../telemetry/runTraceContext';
import type { SubagentExecutionRequest, SubagentResult } from './subagentExecutorTypes';
import { withFileOwnership } from '../services/infra/fileOwnershipRegistry';

export async function runSubagentExecutionWithTrace(
  request: SubagentExecutionRequest,
  run: () => Promise<SubagentResult>,
): Promise<SubagentResult> {
  const { config, context } = request;
  const runWithOwnership = () => withFileOwnership({
    sessionId: context.sessionId,
    agentId: context.agentId,
    swarmRunScope: context.swarmRunScope,
    workingDirectory: context.cwd,
    ownedPaths: context.ownedPaths,
  }, run);
  const parentTraceContext = context.traceContext;
  if (!parentTraceContext) return runWithOwnership();

  const teamScope = context.swarmRunScope;
  const executionAgentId = context.executionAgentId || context.spawnGuardId || config.name;
  const childTraceContext = createChildRunTraceContext(parentTraceContext, {
    runId: teamScope?.runId ?? parentTraceContext.runId,
    sessionId: teamScope?.sessionId ?? parentTraceContext.sessionId,
    engine: teamScope ? 'agent_team' : parentTraceContext.engine,
    agentId: executionAgentId,
    parentRunId: teamScope?.parentNativeRunId ?? parentTraceContext.runId,
  });
  let spanId: string | undefined;
  try {
    const parentToolSpan = context.currentToolCallId
      ? getTelemetryService().findActiveSpanByAttribute('tool.call_id', context.currentToolCallId)
      : undefined;
    spanId = getTelemetryService().startAgentSpan(
      executionAgentId,
      teamScope ? 'agent-team-child' : 'child-agent',
      undefined,
      parentToolSpan?.spanId ?? parentTraceContext.spanId,
      childTraceContext,
    ).spanId;
    getTelemetryService().updateSpan(spanId, {
      ...(teamScope?.treeId ? { 'agent.tree_id': teamScope.treeId } : {}),
      ...(teamScope?.parentNativeRunId ? { 'run.parent_id': teamScope.parentNativeRunId } : {}),
    });
  } catch {
    // Agent tracing must not prevent a child from starting.
  }

  return withRunTraceContext(childTraceContext, async () => {
    try {
      const result = await runWithOwnership();
      try {
        if (spanId) {
          getTelemetryService().endSpan(
            spanId,
            result.success ? 'ok' : result.cancellationReason ? 'cancelled' : 'error',
            {
              'agent.result_status': result.success
                ? 'success'
                : result.cancellationReason ? 'cancelled' : 'failed',
            },
          );
        }
      } catch {
        // Agent completion must not depend on tracing availability.
      }
      return result;
    } catch (error) {
      try {
        if (spanId) {
          getTelemetryService().endSpan(spanId, 'error', { 'agent.result_status': 'failed' });
        }
      } catch {
        // Preserve the original agent error.
      }
      throw error;
    }
  });
}

import { generateMessageId } from '../../shared/utils/id';
import type { SubagentEventPort } from './subagentExecutorTypes';

export type SubagentRunEndStatus = 'completed' | 'cancelled' | 'failed';

export interface SubagentEventIdentity {
  agentId: string;
  runId: string;
  parentToolUseId?: string;
}

function buildSubagentEventIdentity(
  identity: SubagentEventIdentity,
): SubagentEventIdentity {
  return {
    agentId: identity.agentId,
    runId: identity.runId,
    ...(identity.parentToolUseId
      ? { parentToolUseId: identity.parentToolUseId }
      : {}),
  };
}

function createSubagentLifecycleEvents(input: {
  events: SubagentEventPort;
  identity: SubagentEventIdentity;
  generateTurnId?: () => string;
}) {
  const correlation = buildSubagentEventIdentity(input.identity);
  const activeTurnIds = new Set<string>();
  let runEnded = false;

  const endTurn = (turnId: string): boolean => {
    if (!activeTurnIds.delete(turnId)) return false;
    input.events.emit('turn_end', { turnId, ...correlation });
    return true;
  };

  return {
    startTurn(iteration: number): string {
      const turnId = input.generateTurnId?.() ?? generateMessageId();
      activeTurnIds.add(turnId);
      input.events.emit('turn_start', { turnId, iteration, ...correlation });
      return turnId;
    },
    endTurn,
    endRun(status: SubagentRunEndStatus, error?: string): boolean {
      if (runEnded) return false;
      runEnded = true;
      for (const turnId of [...activeTurnIds]) endTurn(turnId);
      input.events.emit('subagent_run_end', {
        ...correlation,
        status,
        ...(error ? { error } : {}),
      });
      return true;
    },
  };
}

export function createSubagentEventScope(input: {
  events: SubagentEventPort;
  identity: SubagentEventIdentity;
  generateTurnId?: () => string;
}) {
  const identity = buildSubagentEventIdentity(input.identity);
  const lifecycle = createSubagentLifecycleEvents({
    events: input.events,
    identity,
    generateTurnId: input.generateTurnId,
  });
  return {
    identity,
    ...lifecycle,
    emitToolCallStart(toolCall: { id: string; name: string; arguments: Record<string, unknown> }): void {
      input.events.emit('tool_call_start', { ...toolCall, ...identity });
    },
    emitToolCallEnd(
      toolCallId: string,
      result: { success: boolean; output?: string; error?: string },
      duration: number,
    ): void {
      input.events.emit('tool_call_end', {
        toolCallId,
        success: result.success,
        output: result.output,
        error: result.error,
        duration,
        ...identity,
      });
    },
    emitToolCallError(toolCallId: string, error: string, duration: number): void {
      input.events.emit('tool_call_end', {
        toolCallId, success: false, error, duration, ...identity,
      });
    },
  };
}

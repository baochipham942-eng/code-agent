import type { ToolContext } from '../../../protocol/tools';
import {
  isSameSwarmRun,
  parseScopedSwarmAgentId,
  type SwarmRunScope,
} from '../../../../shared/contract/swarm';

export interface AgentTargetScopeResult {
  scope?: SwarmRunScope;
  error?: string;
}

/** Validate that a tool caller cannot address an agent outside its session/run. */
export function resolveAgentTargetScope(
  ctx: ToolContext,
  agentId: string,
): AgentTargetScopeResult {
  const parsed = parseScopedSwarmAgentId(agentId);
  const callerScope = ctx.swarmRunScope;

  if (parsed && parsed.scope.sessionId !== ctx.sessionId) {
    return { error: 'Agent belongs to a different session.' };
  }
  if (callerScope) {
    if (
      !parsed
      || !isSameSwarmRun(parsed.scope, callerScope)
      || parsed.scope.treeId !== callerScope.treeId
    ) {
      return { error: 'Agent belongs to a different Team run.' };
    }
    return { scope: callerScope };
  }

  return { scope: parsed?.scope };
}

export function getCallerAgentScope(ctx: ToolContext): SwarmRunScope | undefined {
  return ctx.swarmRunScope;
}

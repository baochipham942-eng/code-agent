import { getPermissionModeManager } from '../permissions/modes';
import type { ParentContext } from './childContext';
import type { SubagentExecutionContext } from './subagentExecutorTypes';
import { resolveModelDecision } from '../model/modelDecision';

export function resolveSubagentParentContext(
  context: SubagentExecutionContext,
): ParentContext {
  if (context.parentContext) return context.parentContext;
  return {
    rules: [],
    memory: [],
    hooks: [],
    skills: [],
    mcpConnections: [],
    permissionMode: getPermissionModeManager().getModeForSession(context.sessionId) as string,
    availableTools: [],
    deny: [],
    ask: [],
    allow: [],
    blockedCommands: [],
    role: context.agentRole,
  };
}

export function normalizeSubagentModelContext(
  context: SubagentExecutionContext,
  role: string,
): SubagentExecutionContext {
  const { config } = resolveModelDecision({
    requestedConfig: context.modelConfig,
    messages: [],
    context: 'subagent',
    subagentRole: role,
  });
  return { ...context, modelConfig: config };
}

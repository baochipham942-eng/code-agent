import type {
  CanUseToolFn,
  ToolContext as ProtocolToolContext,
} from '../protocol/tools';
import type { ModelConfig } from '../../shared/contract';
import type { RunTraceContext } from '../telemetry/runTraceContext';
import type {
  SubagentExecutionContext,
  SubagentEventPort,
  SubagentHookPort,
  SubagentPermissionRequest,
  SubagentToolResolverPort,
} from './subagentExecutorTypes';

export interface ProtocolSubagentExecutionOverrides {
  modelConfig?: ModelConfig;
  resolver?: SubagentToolResolverPort;
  abortSignal?: AbortSignal;
  currentToolCallId?: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  spawnDepth?: number;
  spawnMaxDepth?: number;
  spawnTreeId?: string;
  spawnParentAgentId?: string;
  parentRemainingBudget?: number;
  progress?: SubagentEventPort['progress'];
}

function permissionReason(request: SubagentPermissionRequest): string | undefined {
  return request.type === 'dangerous_command' && request.reason
    ? `dangerous:${request.reason}`
    : request.reason;
}

export function createProtocolSubagentExecutionContext(
  ctx: ProtocolToolContext,
  canUseTool: CanUseToolFn,
  overrides: ProtocolSubagentExecutionOverrides = {},
): SubagentExecutionContext {
  const modelConfig = overrides.modelConfig ?? ctx.modelConfig as ModelConfig | undefined;
  const resolver = overrides.resolver ?? ctx.resolver as SubagentToolResolverPort | undefined;
  if (!modelConfig) {
    throw new Error('Subagent execution requires modelConfig in protocol context');
  }
  if (!resolver) {
    throw new Error('Subagent execution requires resolver in protocol context');
  }

  return {
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    workspace: ctx.workspace,
    cwd: ctx.workingDir,
    modelConfig,
    resolver,
    permission: {
      request: async (request) => {
        const result = await canUseTool(
          request.tool,
          request.details,
          permissionReason(request),
          {
            sessionId: request.sessionId,
            forceConfirm: request.forceConfirm,
            type: request.type,
            tool: request.tool,
            details: request.details,
            reason: request.reason,
            dangerLevel: request.dangerLevel,
            decisionTrace: request.decisionTrace,
          },
        );
        return result.allow;
      },
    },
    hooks: ctx.hookManager as SubagentHookPort | undefined,
    events: {
      emit: (event, data) => ctx.emit({ type: event, data } as never),
      progress: overrides.progress,
    },
    abortSignal: overrides.abortSignal ?? ctx.abortSignal,
    traceContext: ctx.traceContext as RunTraceContext | undefined,
    currentToolCallId: overrides.currentToolCallId ?? ctx.currentToolCallId,
    agentId: overrides.agentId ?? ctx.subagent?.agentId,
    agentName: overrides.agentName ?? ctx.subagent?.agentName,
    agentRole: overrides.agentRole ?? ctx.subagent?.agentRole,
    messages: ctx.subagent?.messages as SubagentExecutionContext['messages'],
    modifiedFiles: ctx.subagent?.modifiedFiles as Set<string> | undefined,
    todos: ctx.subagent?.todos as SubagentExecutionContext['todos'],
    attachments: ctx.subagent?.attachments as SubagentExecutionContext['attachments'],
    spawnDepth: overrides.spawnDepth ?? ctx.spawnDepth,
    spawnMaxDepth: overrides.spawnMaxDepth ?? ctx.spawnMaxDepth,
    spawnTreeId: overrides.spawnTreeId ?? ctx.spawnTreeId,
    swarmRunScope: ctx.swarmRunScope,
    parentNativeRunId: ctx.swarmRunScope?.parentNativeRunId ?? ctx.runId,
    spawnQueueTimeoutMs: ctx.spawnQueueTimeoutMs,
    spawnParentStartedAt: ctx.spawnParentStartedAt,
    spawnParentTimeoutMs: ctx.spawnParentTimeoutMs,
    parentRemainingBudget: overrides.parentRemainingBudget ?? ctx.parentRemainingBudget,
    spawnParentAgentId: overrides.spawnParentAgentId ?? ctx.spawnParentAgentId,
    toolScope: ctx.toolScope,
    executionIntent: ctx.executionIntent,
  };
}

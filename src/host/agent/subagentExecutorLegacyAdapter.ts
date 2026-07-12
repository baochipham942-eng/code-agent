import type { ModelConfig } from '../../shared/contract';
import type { ToolContext } from '../tools/types';
import type { ToolResolver } from '../tools/dispatch/toolResolver';
import { getActiveRunTraceContext } from '../telemetry/runTraceContext';
import type {
  SubagentConfig,
  SubagentExecutionContext,
  SubagentExecutionRequest,
  SubagentHookPort,
} from './subagentExecutorTypes';

/**
 * Compatibility-only mapping for tests and callers not yet on the production
 * protocol path. It performs field projection only and owns no execution policy.
 */
export interface LegacySubagentContextInput {
  modelConfig: ModelConfig;
  toolResolver: ToolResolver;
  toolContext: ToolContext;
  attachments?: SubagentExecutionContext['attachments'];
  parentToolUseId?: string;
  abortSignal?: AbortSignal;
  spawnGuardId?: string;
  messageDrain?: SubagentExecutionContext['messageDrain'];
  executionAgentId?: string;
  parentContext?: SubagentExecutionContext['parentContext'];
  parentRemainingBudget?: number;
  worktreePath?: string;
  capabilityManifest?: SubagentExecutionContext['capabilityManifest'];
  onContextSnapshot?: SubagentExecutionContext['onContextSnapshot'];
  hookManager?: SubagentHookPort;
  isParentAlive?: () => boolean;
}

export function projectLegacySubagentContext(input: LegacySubagentContextInput): SubagentExecutionContext {
  const toolContext = input.toolContext;
  return {
    runId: toolContext.runId,
    sessionId: toolContext.sessionId?.trim() || 'unknown',
    workspace: toolContext.workspace,
    cwd: toolContext.workingDirectory,
    modelConfig: input.modelConfig,
    resolver: input.toolResolver,
    permission: { request: toolContext.requestPermission },
    hooks: input.hookManager ?? toolContext.hookManager,
    events: {
      emit: (event, data) => (toolContext.emitEvent ?? toolContext.emit)?.(event, data),
    },
    abortSignal: input.abortSignal ?? toolContext.abortSignal ?? new AbortController().signal,
    traceContext: getActiveRunTraceContext(),
    currentToolCallId: input.parentToolUseId ?? toolContext.currentToolCallId,
    agentId: toolContext.agentId,
    agentName: toolContext.agentName,
    agentRole: toolContext.agentRole,
    messages: toolContext.messages,
    modifiedFiles: toolContext.modifiedFiles,
    todos: toolContext.todos,
    attachments: input.attachments ?? toolContext.currentAttachments,
    spawnDepth: toolContext.spawnDepth,
    spawnMaxDepth: toolContext.spawnMaxDepth,
    spawnTreeId: toolContext.spawnTreeId,
    swarmRunScope: toolContext.swarmRunScope,
    parentNativeRunId: toolContext.swarmRunScope?.parentNativeRunId ?? toolContext.runId,
    spawnQueueTimeoutMs: toolContext.spawnQueueTimeoutMs,
    spawnParentStartedAt: toolContext.spawnParentStartedAt,
    spawnParentTimeoutMs: toolContext.spawnParentTimeoutMs,
    parentRemainingBudget: input.parentRemainingBudget ?? toolContext.parentRemainingBudget,
    spawnParentAgentId: toolContext.spawnParentAgentId,
    toolScope: toolContext.toolScope,
    executionIntent: toolContext.executionIntent,
    spawnGuardId: input.spawnGuardId,
    messageDrain: input.messageDrain,
    executionAgentId: input.executionAgentId,
    parentContext: input.parentContext,
    worktreePath: input.worktreePath,
    capabilityManifest: input.capabilityManifest,
    onContextSnapshot: input.onContextSnapshot,
    isParentAlive: input.isParentAlive,
  };
}

export function normalizeSubagentExecutionRequest(
  requestOrPrompt: SubagentExecutionRequest | string,
  legacyConfig?: SubagentConfig,
  legacyContext?: LegacySubagentContextInput,
): SubagentExecutionRequest {
  return typeof requestOrPrompt === 'string'
    ? {
        prompt: requestOrPrompt,
        config: legacyConfig as SubagentConfig,
        context: projectLegacySubagentContext(legacyContext as LegacySubagentContextInput),
      }
    : requestOrPrompt;
}

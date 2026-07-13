import { createRunContext } from '../runtime/runContext';
import { ToolExecutor } from '../tools/toolExecutor';
import { getPermissionLevel } from './orchestrator/modelConfigResolver';
import { permissionModeAutoApproves, type PermissionMode } from '../permissions/modes';
import type { ToolExecutionRequest } from './subagentPipeline';
import type { SubagentExecutionContext } from './subagentExecutorTypes';

export function createSubagentToolRuntime(input: {
  context: SubagentExecutionContext;
  sessionId: string;
  effectiveMode: string;
  allowedToolNames: Set<string>;
  checkToolExecution(request: ToolExecutionRequest): boolean;
}) {
  const { context } = input;
  const nativeRunContext = context.runId && input.sessionId && context.workspace
    ? createRunContext({
      runId: context.runId,
      sessionId: input.sessionId,
      workspace: context.workspace,
      cwd: context.cwd,
    })
    : undefined;
  const executor = new ToolExecutor({
    workingDirectory: nativeRunContext?.cwd ?? context.cwd,
    runContext: nativeRunContext,
    permissionModeOverride: input.effectiveMode as PermissionMode,
    executionTopology: 'main',
    requestPermission: async (request) => {
      if (
        input.effectiveMode === 'bypassPermissions'
        || permissionModeAutoApproves(input.effectiveMode, getPermissionLevel(request.type))
      ) return true;
      return context.permission.request(request);
    },
  });
  const policy = {
    allowedTools: input.allowedToolNames,
    check: (toolName: string, params: Record<string, unknown>): 'deny' | 'ask' => {
      const definition = context.resolver.getDefinition(toolName);
      const request: ToolExecutionRequest = {
        toolName,
        permissionLevel: definition?.permissionLevel ?? 'read',
        path: (params.path as string | undefined) ?? (params.file_path as string | undefined),
        command: params.command as string | undefined,
        url: params.url as string | undefined,
      };
      return input.checkToolExecution(request) ? 'ask' : 'deny';
    },
  };
  return { executor, policy };
}

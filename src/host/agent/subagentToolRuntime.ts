import { createRunContext } from '../runtime/runContext';
import { resolveBackgroundWorkspaceAuthority } from '../runtime/workspaceAuthority';
import { ToolExecutor } from '../tools/toolExecutor';
import { getPermissionLevel } from './orchestrator/modelConfigResolver';
import {
  clampUnattendedPermissionMode,
  permissionModeAutoApproves,
  type PermissionMode,
} from '../permissions/modes';
import { isAgentWorktreePath } from './agentWorktreePath';
import type { ToolExecutionRequest } from './subagentPipeline';
import type { SubagentExecutionContext } from './subagentExecutorTypes';
import type { SubagentEventIdentity } from './subagentLifecycleEvents';

export function createSubagentToolRuntime(input: {
  context: SubagentExecutionContext;
  sessionId: string;
  effectiveMode: string;
  identity: SubagentEventIdentity;
  allowedToolNames: Set<string>;
  checkToolExecution(request: ToolExecutionRequest): boolean;
}) {
  const { context } = input;
  const effectiveMode = context.executionTopology === 'async_agent' && input.effectiveMode !== 'readOnly'
    ? clampUnattendedPermissionMode(input.effectiveMode as PermissionMode)
    : input.effectiveMode;
  const worktreeWorkspace = isAgentWorktreePath(context.cwd) ? context.cwd : undefined;
  const runWorkspace = worktreeWorkspace ?? context.workspace;
  const runWorkspaceScope = worktreeWorkspace
    ? resolveBackgroundWorkspaceAuthority({ workspace: worktreeWorkspace })
    : context.workspaceScope;
  const nativeRunContext = context.runId && input.sessionId && runWorkspace
    ? createRunContext({
      runId: context.runId,
      sessionId: input.sessionId,
      workspace: runWorkspace,
      workspaceScope: runWorkspaceScope,
      cwd: context.cwd,
    })
    : undefined;
  const executor = new ToolExecutor({
    workingDirectory: nativeRunContext?.cwd ?? context.cwd,
    runContext: nativeRunContext,
    permissionModeOverride: effectiveMode as PermissionMode,
    // 拓扑由构造点显式标注（SubagentExecutionContext.executionTopology），缺省 main：
    // 未标注的子 agent 路径不受 TOPOLOGY_RULES 约束（Option A 保守默认）。
    executionTopology: context.executionTopology ?? 'main',
    ledgerOrigin: 'subagent',
    telemetryCollector: context.telemetryCollector,
    requestPermission: async (request) => {
      const forceConfirm = request.forceConfirm === true;
      if (
        !forceConfirm
        && (
          effectiveMode === 'bypassPermissions'
          || permissionModeAutoApproves(effectiveMode, getPermissionLevel(request.type))
        )
      ) return true;
      return context.permission.request({ ...request, ...input.identity });
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

import { createRunContext } from '../runtime/runContext';
import { resolveBackgroundWorkspaceAuthority } from '../runtime/workspaceAuthority';
import { createWorkspaceScope, isPathWithinRoot } from '../runtime/workspaceScope';
import { getMemoryDir } from '../lightMemory/indexLoader';
import { ToolExecutor } from '../tools/toolExecutor';
import type { WorkspaceScope } from '../../shared/contract/project';
import { getPermissionLevel } from './orchestrator/modelConfigResolver';
import { permissionModeAutoApproves, type PermissionMode } from '../permissions/modes';
import { isAgentWorktreePath } from './agentWorktreePath';
import type { ToolExecutionRequest } from './subagentPipeline';
import type { SubagentExecutionContext } from './subagentExecutorTypes';
import type { SubagentEventIdentity } from './subagentLifecycleEvents';

/**
 * N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE 修复轮 2：worktree 子代理重建 scope 时保留
 * 父级已授权的附加根（eval-memory）。父 run 的 workspaceScope 是权威授权面，重建只换
 * primary（worktree 根），父级 additional 根原样继承——否则 worktree 子代理的
 * MemoryWrite(scope="global") 目标 <dataDir>/memory/ 落在 worktree 根外，被判
 * PROJECT_SOURCE_OUTSIDE_WORKSPACE，合法记忆任务假阴性（#1686 第二轮「记忆根」形状
 * 往派生链深一层）。与 worktree 根重叠的附加根跳过：createWorkspaceScope 的
 * assertNonOverlappingRoots 会抛，照 buildEvalRunScoping 的双向检查处理。
 */
function inheritParentAdditionalRoots(
  worktreeScope: WorkspaceScope | undefined,
  parentScope: WorkspaceScope | undefined,
  options: { boundaryEnabled: boolean },
): WorkspaceScope | undefined {
  if (!worktreeScope || !parentScope) return worktreeScope;
  const inherited = parentScope.roots
    .filter((root) => root.role !== 'primary')
    .filter((root) => !worktreeScope.roots.some((existing) =>
      isPathWithinRoot(root.path, existing.path) || isPathWithinRoot(existing.path, root.path)));
  const roots = [...worktreeScope.roots, ...inherited];
  // N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE 修复轮 3：记忆目录被父级 primary 折叠时仍显式保留。
  // CODE_AGENT_DATA_DIR 指进沙箱是合法用法（#1686 第三轮认过），此时父级
  // buildEvalRunScoping 只产 primary 单根（防 createWorkspaceScope 的
  // assertNonOverlappingRoots 抛，agentAdapter.ts 的重叠检查跳过 eval-memory 根），
  // 上面的附加根继承没有根可继承 ⇒ worktree 子代理的 MemoryWrite(scope="global")
  // 目标 <dataDir>/memory/（worktree 根在沙箱外）仍被判 PROJECT_SOURCE_OUTSIDE_WORKSPACE。
  // 口径（爸拍板）：记忆目录始终显式保留——判据是父级授权过它（它落在父级任一根内，
  // 折叠或显式同权）；🚫 不继承父级 primary 本体，worktree 隔离语义不动。记忆目录
  // 出处与写目标解析同源：getMemoryDir()（writeTargets.ts 的 global-memory 分支同一
  // 派生链，CODE_AGENT_DATA_DIR ?? ~/.code-agent），不拼路径。只在写边界开着时合成——
  // 关着时子级 scope 多一个根会松 Bash working_directory 闸，非评测链路零变化。
  if (options.boundaryEnabled) {
    const memoryDir = getMemoryDir();
    const parentAuthorizedMemory = parentScope.roots
      .some((root) => isPathWithinRoot(memoryDir, root.path));
    const childCoversMemory = roots.some((root) =>
      isPathWithinRoot(memoryDir, root.path) || isPathWithinRoot(root.path, memoryDir));
    if (parentAuthorizedMemory && !childCoversMemory) {
      roots.push({ sourceId: 'eval-memory', path: memoryDir, role: 'additional', access: 'read_write' });
    }
  }
  if (roots.length === worktreeScope.roots.length) return worktreeScope;
  return createWorkspaceScope(worktreeScope.projectId, roots);
}

export function createSubagentToolRuntime(input: {
  context: SubagentExecutionContext;
  sessionId: string;
  effectiveMode: string;
  identity: SubagentEventIdentity;
  allowedToolNames: Set<string>;
  checkToolExecution(request: ToolExecutionRequest): boolean;
}) {
  const { context } = input;
  const worktreeWorkspace = isAgentWorktreePath(context.cwd) ? context.cwd : undefined;
  const runWorkspace = worktreeWorkspace ?? context.workspace;
  const runWorkspaceScope = worktreeWorkspace
    ? inheritParentAdditionalRoots(
      resolveBackgroundWorkspaceAuthority({ workspace: worktreeWorkspace }),
      context.workspaceScope,
      { boundaryEnabled: context.restrictWritesToWorkspace === true },
    )
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
    // N-EVAL-POLICY-WRITE-BOUNDARY-ENABLE：这里不走 forRun 派生，父执行器的写边界
    // 开关必须显式继承——漏传等于子代理绕过写边界（#1686 第四轮 ai-review 形状）。
    restrictWritesToWorkspace: context.restrictWritesToWorkspace === true,
    permissionModeOverride: input.effectiveMode as PermissionMode,
    // 拓扑由构造点显式标注（SubagentExecutionContext.executionTopology），缺省 main：
    // 未标注的子 agent 路径不受 TOPOLOGY_RULES 约束（Option A 保守默认）。
    executionTopology: context.executionTopology ?? 'main',
    ledgerOrigin: 'subagent',
    // 继承父执行器的契约：父级强制走 handler 时，子代理里分类器自动放行的工具
    // 也必须落到 context.permission.request，否则父级的 scripted 策略对它们是瞎的。
    forcePermissionHandler: context.forcePermissionHandler,
    telemetryCollector: context.telemetryCollector,
    requestPermission: async (request) => {
      const forceConfirm = request.forceConfirm === true;
      if (
        !forceConfirm
        && (
          input.effectiveMode === 'bypassPermissions'
          || permissionModeAutoApproves(input.effectiveMode, getPermissionLevel(request.type))
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

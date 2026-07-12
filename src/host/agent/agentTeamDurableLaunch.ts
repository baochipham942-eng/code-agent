import type { SwarmRunScope } from '../../shared/contract/swarm';
import { normalizeCancellationReason } from '../../shared/contract/cancellation';
import { stableAgentTeamApprovalId } from './agentTeamDurableAdapter';
import {
  agentTeamTaskPermissionProfile,
  getAgentTeamDurableRuntime,
} from './agentTeamDurableAdapter';
import type { AgentTeamDurableController } from './agentTeamDurableTypes';
import type { AgentTask } from './parallelAgentCoordinatorTypes';
import type { ModelConfig } from '../../shared/contract';
import { AgentFailureCode } from '../../shared/contract/agentFailure';
import type { MultiagentExecutionResult } from './multiagentExecutionTypes';
import {
  getSwarmLaunchApprovalGate,
  type SwarmLaunchApprovalResult,
} from './swarmLaunchApproval';

export async function requestDurableAgentTeamLaunchApproval(input: {
  controller: AgentTeamDurableController;
  scope: SwarmRunScope;
  tasks: AgentTask[];
  readonlyRoles: readonly string[];
  abortSignal?: AbortSignal;
}): Promise<SwarmLaunchApprovalResult> {
  const launchGate = getSwarmLaunchApprovalGate();
  const cancelPendingLaunch = () => {
    const reason = normalizeCancellationReason(input.abortSignal?.reason, 'parent-cancel');
    launchGate.cancelRun(input.scope, reason);
  };
  input.abortSignal?.addEventListener('abort', cancelPendingLaunch, { once: true });
  const approvalId = stableAgentTeamApprovalId(input.scope.runId);
  try {
    await input.controller.markApprovalWaiting(approvalId);
    const approval = await launchGate.requestApproval({
      scope: input.scope,
      requestId: approvalId,
      summary: `准备并行启动 ${input.tasks.length} 个 agent`,
      tasks: input.tasks.map((task) => ({
        id: task.id,
        role: task.role,
        task: task.task.replace(/^\[工作目录:[^\]]+\]\s*所有文件路径基于此目录。\n\n/, ''),
        dependsOn: task.dependsOn,
        tools: [...task.tools],
        writeAccess: !input.readonlyRoles.includes(task.role.toLowerCase()),
      })),
    });
    await input.controller.resolveApproval(
      approvalId,
      approval.approved ? 'approved' : 'rejected',
    );
    return approval;
  } finally {
    input.abortSignal?.removeEventListener('abort', cancelPendingLaunch);
  }
}

export function startAgentTeamDurableController(input: {
  scope: SwarmRunScope;
  parentRunId: string;
  logicalOperationId: string;
  tasks: AgentTask[];
  modelConfig: ModelConfig;
}): Promise<AgentTeamDurableController> {
  return getAgentTeamDurableRuntime().start({
    scope: input.scope,
    parentRunId: input.parentRunId,
    logicalOperationId: input.logicalOperationId,
    sideEffect: input.tasks.some((task) => agentTeamTaskPermissionProfile(task) !== 'readonly'),
    tasks: input.tasks,
    model: {
      provider: String(input.modelConfig.provider),
      model: String(input.modelConfig.model),
    },
  });
}

export async function prepareAgentTeamDurableController(input: {
  scope: SwarmRunScope;
  parentRunId: string;
  logicalOperationId: string;
  tasks: AgentTask[];
  modelConfig: ModelConfig;
}): Promise<
  | { controller: AgentTeamDurableController }
  | { result: MultiagentExecutionResult }
> {
  try {
    return { controller: await startAgentTeamDurableController(input) };
  } catch (error) {
    return {
      result: {
        success: false,
        error: `Agent Team durable preparation failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { failureCode: AgentFailureCode.ModelError },
      },
    };
  }
}

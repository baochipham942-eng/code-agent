import { AgentFailureCode } from '../../../shared/contract/agentFailure';
import { createAgentWorktree, worktreeFailureHint } from '../agentWorktree';
import { getParallelAgentCoordinatorRegistry } from '../parallelAgentCoordinator';
import type { MultiagentExecutionResult } from '../multiagentExecutionTypes';
import type { SubagentExecutionContext } from '../subagentExecutorTypes';

type SpawnAgentWorktreeInfo = { worktreePath: string; branchName: string; baseCommit: string };

type PrepareSpawnAgentWorktreeResult =
  | { ok: true; worktreeInfo: SpawnAgentWorktreeInfo }
  | { ok: false; failure: MultiagentExecutionResult };

/**
 * spawn_agent 的 worktree 创建（从 executeSpawnAgent 抽出，行为不变）：
 * 建好后向 swarm 协调器登记；失败回一个可直接返回给调用方的失败结果。
 */
export async function prepareSpawnAgentWorktree(
  agentId: string,
  cwd: string,
  context: Pick<SubagentExecutionContext, 'swarmRunScope' | 'agentId'>,
): Promise<PrepareSpawnAgentWorktreeResult> {
  try {
    const worktreeInfo = await createAgentWorktree(agentId, cwd);
    if (context.swarmRunScope) {
      await getParallelAgentCoordinatorRegistry().get(context.swarmRunScope)?.recordTaskWorktree(context.agentId ?? '', worktreeInfo.worktreePath);
    }
    return { ok: true, worktreeInfo };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    return {
      ok: false,
      failure: {
        success: false,
        error: `Failed to create worktree for agent: ${errMsg}. ${await worktreeFailureHint(cwd)}`,
        metadata: { failureCode: AgentFailureCode.WorktreeCreateFailed },
      },
    };
  }
}

import { AgentFailureCode } from '../../../shared/contract/agentFailure';
import { createAgentWorktree, worktreeFailureHint } from '../agentWorktree';
import { getParallelAgentCoordinatorRegistry } from '../parallelAgentCoordinator';
import { createLogger } from '../../services/infra/logger';
import type { MultiagentExecutionResult } from '../multiagentExecutionTypes';
import type { SubagentExecutionContext } from '../subagentExecutorTypes';

const logger = createLogger('SpawnAgentWorktree');

type SpawnAgentWorktreeInfo = { worktreePath: string; branchName: string; baseCommit: string };

type PrepareSpawnAgentWorktreeResult =
  | { ok: true; worktreeInfo: SpawnAgentWorktreeInfo }
  | { ok: false; failure: MultiagentExecutionResult };

/**
 * 失败探测结论 → metadata.code（renderer `toolErrors.codes` 登记表的键，按档位给人话）。
 * error 原文不变：模型仍读原始 git 报错，只有 renderer 拿 code 换文案。
 */
const WORKTREE_CREATE_ERROR_CODES = {
  'no-repo': 'WORKTREE_NO_REPO',
  'unborn': 'WORKTREE_NO_COMMITS',
  'other': 'WORKTREE_CREATE_FAILED',
} as const;

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
    logger.warn(`[${agentId}] Failed to create worktree for agent; raw git output: ${errMsg}`);
    const { hint, kind } = await worktreeFailureHint(cwd);
    return {
      ok: false,
      failure: {
        success: false,
        error: `Failed to create worktree for agent: ${errMsg}. ${hint}`,
        metadata: {
          failureCode: AgentFailureCode.WorktreeCreateFailed,
          code: WORKTREE_CREATE_ERROR_CODES[kind],
        },
      },
    };
  }
}

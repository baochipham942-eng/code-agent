import type { SubagentResult } from '../subagentExecutorTypes';
import type { SubagentExecutionContext } from '../subagentExecutorTypes';
import type { ManagedAgent } from '../spawnGuard';
import type { MultiagentExecutionResult } from '../multiagentExecutionTypes';
import { getBackgroundSubagentRegistry } from '../backgroundSubagentRegistry';
import { scheduleBackgroundSubagentIdleWake } from '../backgroundSubagentIdleWake';
import { cleanupAgentWorktree, discardAgentWorktree } from '../agentWorktree';
import { AgentFailureCode } from '../../../shared/contract/agentFailure';
import { SUBAGENT_EXECUTION_TIMEOUTS } from '../../../shared/constants';
import { getSubagentExecutionTimeout } from '../subagentExecutorCancellation';

export function resolveForegroundBlockingBudgetMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return SUBAGENT_EXECUTION_TIMEOUTS.FOREGROUND_TO_BACKGROUND_BUDGET;
  }
  return Math.max(1, Math.floor(value));
}

export function validateForegroundBlockingBudget(
  agentName: string,
  foregroundBlockingBudgetMs: number,
): MultiagentExecutionResult | undefined {
  const roleExecutionTimeout = getSubagentExecutionTimeout(agentName);
  if (foregroundBlockingBudgetMs < roleExecutionTimeout) return undefined;
  return {
    success: false,
    error: `foregroundBlockingBudgetMs must be less than role execution timeout (${foregroundBlockingBudgetMs} >= ${roleExecutionTimeout})`,
    metadata: {
      failureCode: AgentFailureCode.BudgetExhausted,
      foregroundBlockingBudgetMs,
      roleExecutionTimeout,
    },
  };
}

export async function raceForegroundBlockingBudget(
  promise: Promise<SubagentResult>,
  foregroundBlockingBudgetMs: number,
): Promise<{ kind: 'result'; result: SubagentResult } | { kind: 'timeout' }> {
  let foregroundTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((result) => ({ kind: 'result' as const, result })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        foregroundTimer = setTimeout(() => resolve({ kind: 'timeout' }), foregroundBlockingBudgetMs);
      }),
    ]);
  } finally {
    if (foregroundTimer) clearTimeout(foregroundTimer);
  }
}

export function adoptForegroundSubagent(options: {
  promise: Promise<SubagentResult>;
  agentId: string;
  agentName: string;
  role: string | undefined;
  context: SubagentExecutionContext;
  treeId: string;
  agentStartedAt: number;
  foregroundBlockingBudgetMs: number;
}): MultiagentExecutionResult {
  const { promise, agentId, agentName, role, context, treeId, agentStartedAt, foregroundBlockingBudgetMs } = options;
  getBackgroundSubagentRegistry().adopt(promise, {
    agentId,
    sessionId: context.sessionId,
    ...(context.runId ? { runId: context.runId } : {}),
    ...(treeId ? { treeId } : {}),
    role: role || 'dynamic',
    startedAt: agentStartedAt,
    suppressIdleWake: Boolean(context.suppressBackgroundSubagentIdleWake),
    ...(context.suppressBackgroundSubagentIdleWake ? { suppressReason: 'goal-loop' as const } : {}),
    onComplete: scheduleBackgroundSubagentIdleWake,
  });
  return {
    success: true,
    output: `Agent [${agentName}] exceeded foreground budget and continues in background:
- task_id=${agentId}
- status=running
- foreground_budget_ms=${foregroundBlockingBudgetMs}

Use collect_agent("${agentId}") to fetch the result.`,
    metadata: {
      agentId,
      taskId: agentId,
      background: true,
      transferredToBackground: true,
      foregroundBlockingBudgetMs,
      ...(context.swarmRunScope ?? {}),
    },
  };
}

export function delegateSpawnAgentWorktreeCleanup(options: {
  guard: { onComplete(callback: (agent: ManagedAgent) => void | Promise<void>): void };
  agentId: string;
  repoPath: string;
  worktreeInfo: { worktreePath: string; baseCommit: string };
  isFinalized: () => boolean;
  markFinalized: () => void;
}): void {
  const { guard, agentId, repoPath, worktreeInfo, isFinalized, markFinalized } = options;
  guard.onComplete(async (completedAgent) => {
    if (completedAgent.id !== agentId || isFinalized()) return;
    if (completedAgent.status === 'cancelled' || completedAgent.status === 'killed') {
      await discardAgentWorktree(agentId, worktreeInfo.worktreePath, repoPath);
    } else {
      await cleanupAgentWorktree(agentId, worktreeInfo.worktreePath, repoPath, worktreeInfo.baseCommit);
    }
    markFinalized();
  });
}

export async function finalizeForegroundSpawnAgentWorktree(options: {
  agentId: string;
  repoPath: string;
  worktreeInfo?: { worktreePath: string; branchName: string; baseCommit: string };
  result: SubagentResult;
  aborted: boolean;
}): Promise<{ worktreeNote: string; finalized: boolean }> {
  const { agentId, repoPath, worktreeInfo, result, aborted } = options;
  if (!worktreeInfo) return { worktreeNote: '', finalized: false };
  if (result.cancellationReason || aborted) {
    await discardAgentWorktree(agentId, worktreeInfo.worktreePath, repoPath);
    return { worktreeNote: '\n- Worktree: discarded after cancellation', finalized: true };
  }
  const cleanup = await cleanupAgentWorktree(agentId, worktreeInfo.worktreePath, repoPath, worktreeInfo.baseCommit);
  return {
    finalized: true,
    worktreeNote: cleanup.hasChanges
      ? `\n- Worktree: preserved at ${cleanup.worktreePath} (branch: ${cleanup.branchName}) — review and merge changes`
      : '\n- Worktree: auto-cleaned (no changes)',
  };
}

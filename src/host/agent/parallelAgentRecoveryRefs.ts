import { access } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentTask, AgentTaskResult } from './parallelAgentCoordinatorTypes';
import {
  createAgentWorktree,
  isValidAgentWorktree,
} from './agentWorktree';

export interface ParallelAgentRecoveryRefs {
  worktrees: Map<string, string>;
  artifacts: Map<string, string[]>;
}

export function createEmptyParallelAgentRecoveryRefs(): ParallelAgentRecoveryRefs {
  return { worktrees: new Map(), artifacts: new Map() };
}

async function allArtifactsExist(refs: string[], cwd: string): Promise<boolean> {
  if (refs.length === 0) return false;
  return (await Promise.all(refs.map(async (ref) => {
    const artifactPath = path.isAbsolute(ref) ? ref : path.resolve(cwd, ref);
    try {
      await access(artifactPath);
      return true;
    } catch {
      return false;
    }
  }))).every(Boolean);
}

export async function resolveRecoveredTaskExecution(input: {
  task: AgentTask;
  refs: ParallelAgentRecoveryRefs;
  cwd: string;
  now?: number;
  onWorktreeCreated?: (worktreePath: string) => Promise<void>;
}): Promise<{ worktreePath?: string; result?: AgentTaskResult }> {
  const recoveredWorktree = input.refs.worktrees.get(input.task.id);
  let worktreePath: string | undefined;
  if (recoveredWorktree) {
    if (await isValidAgentWorktree(recoveredWorktree)) {
      worktreePath = recoveredWorktree;
    } else {
      worktreePath = (await createAgentWorktree(input.task.id, input.cwd)).worktreePath;
      await input.onWorktreeCreated?.(worktreePath);
    }
  }

  const artifactRefs = input.refs.artifacts.get(input.task.id) ?? [];
  if (!await allArtifactsExist(artifactRefs, worktreePath ?? input.cwd)) {
    return { worktreePath };
  }
  const now = input.now ?? Date.now();
  return {
    worktreePath,
    result: {
      success: true,
      output: `Recovered existing artifacts: ${artifactRefs.join(', ')}`,
      toolsUsed: [],
      iterations: 0,
      taskId: input.task.id,
      role: input.task.role,
      startTime: now,
      endTime: now,
      duration: 0,
    },
  };
}

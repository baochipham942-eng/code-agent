// ============================================================================
// Agent Worktree - 为 coder 子代理创建隔离的 Git 工作树
// ============================================================================
//
// 借鉴 Claude Code 的 worktree isolation 模式：
// - 每个 coder agent 在独立分支上工作，避免文件写冲突
// - 无变更时自动清理，有变更时保留供父 agent 决定如何合并
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';

const execAsync = promisify(exec);
const logger = createLogger('AgentWorktree');

const WORKTREE_TIMEOUT = 30_000;

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
}

export interface WorktreeCleanupResult {
  hasChanges: boolean;
  branchName: string;
  /** If changes exist, the worktree path is preserved */
  worktreePath?: string;
}

/**
 * Create an isolated git worktree for an agent.
 * Branch name: agent/{agentId}
 * Path: /tmp/code-agent-worktrees/{agentId}
 */
export async function createAgentWorktree(
  agentId: string,
  repoPath: string,
  baseBranch?: string
): Promise<WorktreeInfo> {
  const branchName = `agent/${agentId}`;
  const safeName = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const worktreePath = path.join('/tmp/code-agent-worktrees', safeName);

  // Determine base: explicit param or current HEAD
  const base = baseBranch || 'HEAD';

  const cmd = `git worktree add -b '${branchName}' '${worktreePath}' '${base}'`;
  logger.info(`[${agentId}] Creating worktree: ${cmd}`);

  await execAsync(cmd, { cwd: repoPath, timeout: WORKTREE_TIMEOUT });

  logger.info(`[${agentId}] Worktree created at ${worktreePath} (branch: ${branchName})`);
  return { worktreePath, branchName };
}

/**
 * Cleanup an agent's worktree after execution.
 * - If no changes: remove worktree + delete branch
 * - If changes exist: keep worktree, return info for parent to decide
 */
export async function cleanupAgentWorktree(
  agentId: string,
  worktreePath: string,
  repoPath: string
): Promise<WorktreeCleanupResult> {
  const branchName = `agent/${agentId}`;

  try {
    // Check for uncommitted changes in worktree
    const { stdout: statusOutput } = await execAsync(
      `git -C '${worktreePath}' status --porcelain`,
      { timeout: WORKTREE_TIMEOUT }
    );

    // Check diff against the parent branch point
    const { stdout: diffOutput } = await execAsync(
      `git -C '${worktreePath}' diff HEAD --stat 2>/dev/null || true`,
      { timeout: WORKTREE_TIMEOUT }
    );

    const hasChanges = statusOutput.trim().length > 0 || diffOutput.trim().length > 0;

    if (!hasChanges) {
      // No changes — clean up
      await execAsync(
        `git worktree remove '${worktreePath}'`,
        { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
      );
      await execAsync(
        `git branch -d '${branchName}'`,
        { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
      ).catch(() => {
        // Branch delete may fail if already deleted, ignore
      });
      logger.info(`[${agentId}] Worktree cleaned up (no changes)`);
      return { hasChanges: false, branchName };
    }

    // Has changes — preserve worktree
    logger.info(`[${agentId}] Worktree preserved (has changes) at ${worktreePath}`);
    return { hasChanges: true, branchName, worktreePath };
  } catch (err) {
    logger.warn(`[${agentId}] Worktree cleanup error:`, err);
    // On error, try force removal to avoid leaked worktrees
    try {
      await execAsync(
        `git worktree remove --force '${worktreePath}'`,
        { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
      );
      await execAsync(
        `git branch -D '${branchName}'`,
        { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
      ).catch(() => {});
    } catch {
      // Best effort cleanup
    }
    return { hasChanges: false, branchName };
  }
}

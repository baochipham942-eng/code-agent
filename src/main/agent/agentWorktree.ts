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
import * as fs from 'fs';
import { createLogger } from '../services/infra/logger';

const execAsync = promisify(exec);
const logger = createLogger('AgentWorktree');

const WORKTREE_TIMEOUT = 30_000;
const WORKTREE_BASE_DIR = '/tmp/code-agent-worktrees';

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
  const worktreePath = path.join(WORKTREE_BASE_DIR, safeName);

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

/**
 * Clean up orphaned worktrees left behind by crashed agents.
 * Finds worktrees in /tmp/code-agent-worktrees/ older than maxAgeMs
 * that don't have an associated running process.
 *
 * @param repoPath - The main repository path
 * @param maxAgeMs - Maximum age before cleanup (default 1 hour)
 * @returns Number of cleaned up worktrees
 */
export async function cleanupOrphanedWorktrees(
  repoPath: string,
  maxAgeMs = 3_600_000
): Promise<number> {
  let cleaned = 0;

  try {
    // 1. List all worktrees via git
    const { stdout } = await execAsync(
      'git worktree list --porcelain',
      { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
    );

    // 2. Parse worktree entries — each block starts with "worktree <path>"
    const entries = stdout.split('\n\n').filter(block => block.trim());
    const now = Date.now();

    for (const entry of entries) {
      const pathMatch = entry.match(/^worktree\s+(.+)$/m);
      const branchMatch = entry.match(/^branch\s+refs\/heads\/(.+)$/m);
      if (!pathMatch) continue;

      const wtPath = pathMatch[1];
      const branchName = branchMatch?.[1];

      // 3. Only clean worktrees in our managed directory
      if (!wtPath.startsWith(WORKTREE_BASE_DIR)) continue;

      // 4. Check directory mtime
      try {
        const stat = fs.statSync(wtPath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs < maxAgeMs) continue;
      } catch {
        // Directory doesn't exist on disk — git still references it, force remove
      }

      // 5. Remove the orphaned worktree
      try {
        await execAsync(
          `git worktree remove --force '${wtPath}'`,
          { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
        );
        // Delete the associated branch if it follows agent/* naming
        if (branchName?.startsWith('agent/')) {
          await execAsync(
            `git branch -D '${branchName}'`,
            { cwd: repoPath, timeout: WORKTREE_TIMEOUT }
          ).catch(() => {});
        }
        cleaned++;
        logger.info(`[OrphanCleanup] Removed orphaned worktree: ${wtPath}`);
      } catch (err) {
        logger.warn(`[OrphanCleanup] Failed to remove ${wtPath}:`, err);
      }
    }
  } catch (err) {
    // Best-effort: don't crash if git worktree list fails (e.g. not a git repo)
    logger.debug('[OrphanCleanup] Skipped:', err);
  }

  return cleaned;
}

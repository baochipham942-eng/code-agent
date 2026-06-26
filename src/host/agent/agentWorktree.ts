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
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger } from '../services/infra/logger';
import { captureWorkspacePatch } from '../services/checkpoint/taskPatchService';
import {
  makeEvidenceRef,
  type EvidenceRef,
} from '../../shared/contract/evidence';
import type {
  AgentTreeChangedFile,
  AgentWorktreeArtifact,
  AgentWorktreeReview,
} from '../../shared/contract/agentTree';

const execAsync = promisify(exec);
const logger = createLogger('AgentWorktree');

const WORKTREE_TIMEOUT = 30_000;
const WORKTREE_BASE_DIR = path.join(os.tmpdir(), 'code-agent-worktrees');
const MAX_WORKTREE_DIFF_CHARS = 20_000;

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

const worktreeArtifacts = new Map<string, AgentWorktreeArtifact>();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function cloneChangedFiles(files?: AgentTreeChangedFile[]): AgentTreeChangedFile[] | undefined {
  return files?.map((file) => ({ ...file }));
}

function cloneEvidenceRefs(refs?: EvidenceRef[]): EvidenceRef[] | undefined {
  return refs?.map((ref) => ({
    ...ref,
    freshness: { ...ref.freshness },
  }));
}

function cloneArtifact(artifact: AgentWorktreeArtifact): AgentWorktreeArtifact {
  return {
    ...artifact,
    ...(artifact.changedFiles ? { changedFiles: cloneChangedFiles(artifact.changedFiles) } : {}),
    ...(artifact.evidenceRefs ? { evidenceRefs: cloneEvidenceRefs(artifact.evidenceRefs) } : {}),
  };
}

function makeWorktreeEvidenceRef(agentId: string, worktreePath: string, kind: 'diff' | 'file'): EvidenceRef {
  return makeEvidenceRef({
    kind,
    ref: worktreePath,
    source: `agentWorktree:${agentId}`,
    state: 'fresh',
  });
}

function recordWorktreeArtifact(
  agentId: string,
  next: Omit<AgentWorktreeArtifact, 'agentId' | 'updatedAt'> & { updatedAt?: number },
): AgentWorktreeArtifact {
  const existing = worktreeArtifacts.get(agentId);
  const artifact: AgentWorktreeArtifact = {
    agentId,
    updatedAt: next.updatedAt ?? Date.now(),
    status: next.status,
    ...(next.path ? { path: next.path } : existing?.path ? { path: existing.path } : {}),
    ...(next.branch ? { branch: next.branch } : existing?.branch ? { branch: existing.branch } : {}),
    ...(next.repoPath ? { repoPath: next.repoPath } : existing?.repoPath ? { repoPath: existing.repoPath } : {}),
    ...(next.changedFiles ? { changedFiles: cloneChangedFiles(next.changedFiles) } : {}),
    ...(next.diffSummary ? { diffSummary: next.diffSummary } : {}),
    ...(next.evidenceRefs ? { evidenceRefs: cloneEvidenceRefs(next.evidenceRefs) } : {}),
    ...(next.error ? { error: next.error } : {}),
  };
  worktreeArtifacts.set(agentId, artifact);
  return cloneArtifact(artifact);
}

export function listAgentWorktreeArtifacts(): AgentWorktreeArtifact[] {
  return Array.from(worktreeArtifacts.values()).map(cloneArtifact);
}

export function getAgentWorktreeArtifact(agentId: string): AgentWorktreeArtifact | undefined {
  const artifact = worktreeArtifacts.get(agentId);
  return artifact ? cloneArtifact(artifact) : undefined;
}

export function resetAgentWorktreeArtifactsForTest(): void {
  worktreeArtifacts.clear();
}

export function parseGitStatusPorcelain(output: string): AgentTreeChangedFile[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const pathPart = rawPath.includes(' -> ')
        ? rawPath.split(' -> ').pop() ?? rawPath
        : rawPath;
      const normalizedCode = code.replace(/\s/g, '');
      const status: AgentTreeChangedFile['status'] = normalizedCode.includes('?')
        ? 'untracked'
        : normalizedCode.includes('R')
          ? 'renamed'
          : normalizedCode.includes('C')
            ? 'copied'
            : normalizedCode.includes('A')
              ? 'added'
              : normalizedCode.includes('D')
                ? 'deleted'
                : normalizedCode.includes('M')
                  ? 'modified'
                  : 'unknown';
      return {
        path: pathPart.replace(/^"|"$/g, ''),
        status,
      };
    });
}

async function readChangedFiles(worktreePath: string): Promise<AgentTreeChangedFile[]> {
  const { stdout } = await execAsync(
    `git -C ${shellQuote(worktreePath)} status --porcelain`,
    { timeout: WORKTREE_TIMEOUT }
  );
  return parseGitStatusPorcelain(stdout);
}

async function readDiffSummary(worktreePath: string): Promise<string> {
  const { stdout } = await execAsync(
    `git -C ${shellQuote(worktreePath)} diff HEAD --stat 2>/dev/null || true`,
    { timeout: WORKTREE_TIMEOUT }
  );
  return stdout.trim();
}

async function readDiff(worktreePath: string): Promise<{ diff: string; truncated: boolean }> {
  const { stdout } = await execAsync(
    `git -C ${shellQuote(worktreePath)} diff HEAD -- 2>/dev/null || true`,
    { timeout: WORKTREE_TIMEOUT, maxBuffer: MAX_WORKTREE_DIFF_CHARS * 2 }
  );
  const truncated = stdout.length > MAX_WORKTREE_DIFF_CHARS;
  return {
    diff: truncated
      ? `${stdout.slice(0, MAX_WORKTREE_DIFF_CHARS)}\n\n[变更内容较长，已截断。]`
      : stdout,
    truncated,
  };
}

export async function getAgentWorktreeReview(agentId: string): Promise<AgentWorktreeReview | undefined> {
  const artifact = worktreeArtifacts.get(agentId);
  if (!artifact) return undefined;
  const worktreePath = artifact.path;
  if (!worktreePath || artifact.status === 'cleaned') {
    return cloneArtifact(artifact);
  }

  try {
    const [changedFiles, diffSummary, diff] = await Promise.all([
      readChangedFiles(worktreePath),
      readDiffSummary(worktreePath),
      readDiff(worktreePath),
    ]);
    const evidenceRefs = [makeWorktreeEvidenceRef(agentId, worktreePath, 'diff')];
    const refreshed = recordWorktreeArtifact(agentId, {
      ...artifact,
      changedFiles,
      diffSummary,
      evidenceRefs,
      updatedAt: Date.now(),
    });
    return {
      ...refreshed,
      diff: diff.diff,
      truncated: diff.truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const refreshed = recordWorktreeArtifact(agentId, {
      ...artifact,
      status: 'error',
      error: message,
      updatedAt: Date.now(),
    });
    return refreshed;
  }
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

  try {
    await execAsync(cmd, { cwd: repoPath, timeout: WORKTREE_TIMEOUT });
  } catch (err) {
    recordWorktreeArtifact(agentId, {
      status: 'error',
      path: worktreePath,
      branch: branchName,
      repoPath,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  logger.info(`[${agentId}] Worktree created at ${worktreePath} (branch: ${branchName})`);
  recordWorktreeArtifact(agentId, {
    status: 'active',
    path: worktreePath,
    branch: branchName,
    repoPath,
    evidenceRefs: [makeWorktreeEvidenceRef(agentId, worktreePath, 'file')],
  });

  // 共享主仓库的 gitignored 依赖目录（如 node_modules）到 worktree，避免每个并行 agent
  // 重新 npm install。best-effort：任一 symlink 失败只记 warning，不让 worktree 创建失败。
  await shareGitignoredDirs(agentId, repoPath, worktreePath);

  return { worktreePath, branchName };
}

/**
 * Parse the top-level plain directory entries from a .gitignore file.
 * Only handles bare directory-name entries (e.g. `node_modules/`, `dist`, `.next/`).
 * Skips entries that contain wildcards, path separators, negations, or that are
 * comments/blank — those are too complex to safely map to a single top-level dir.
 */
export function parseGitignoreTopLevelDirs(gitignoreContent: string): string[] {
  const dirs: string[] = [];
  for (const rawLine of gitignoreContent.split('\n')) {
    const line = rawLine.trim();
    // Skip blanks, comments, negations
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    // Skip anything with a glob char or an embedded path separator
    if (/[*?[\]]/.test(line)) continue;
    // Strip a single trailing slash (directory marker), then reject if a slash remains
    const stripped = line.endsWith('/') ? line.slice(0, -1) : line;
    if (!stripped || stripped.includes('/')) continue;
    dirs.push(stripped);
  }
  return dirs;
}

/**
 * Best-effort: symlink the main repo's gitignored top-level directories into the
 * new worktree so parallel agents reuse installed deps instead of re-installing.
 * Any single failure is logged as a warning and skipped — never throws.
 */
async function shareGitignoredDirs(
  agentId: string,
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    const gitignorePath = path.join(repoPath, '.gitignore');
    let content: string;
    try {
      content = fs.readFileSync(gitignorePath, 'utf-8');
    } catch {
      // No .gitignore (or unreadable) — nothing to share
      return;
    }

    const entries = parseGitignoreTopLevelDirs(content);
    for (const entry of entries) {
      const source = path.join(repoPath, entry);
      const target = path.join(worktreePath, entry);
      try {
        // Source must exist and be a directory
        const sourceStat = fs.statSync(source);
        if (!sourceStat.isDirectory()) continue;
        // Skip if the worktree already has this path (file or dir)
        if (fs.existsSync(target)) continue;
        fs.symlinkSync(source, target, 'dir');
        logger.debug(`[${agentId}] Shared gitignored dir via symlink: ${entry}`);
      } catch (err) {
        logger.warn(`[${agentId}] Failed to share gitignored dir '${entry}':`, err);
      }
    }
  } catch (err) {
    // Whole step is best-effort; never block worktree creation
    logger.warn(`[${agentId}] shareGitignoredDirs failed:`, err);
  }
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
      recordWorktreeArtifact(agentId, {
        status: 'cleaned',
        branch: branchName,
        repoPath,
        changedFiles: [],
        diffSummary: '',
      });
      logger.info(`[${agentId}] Worktree cleaned up (no changes)`);
      return { hasChanges: false, branchName };
    }

    // Has changes — capture a patch safety net, then preserve worktree for
    // the parent to review/merge. The patch means the changes survive even if
    // the worktree is later force-removed (orphan cleanup / crash).
    // best-effort: capture failure never blocks cleanup.
    try {
      await captureWorkspacePatch(worktreePath, agentId, 'worktree-cleanup');
    } catch (err) {
      logger.warn(`[${agentId}] captureWorkspacePatch failed during cleanup:`, err);
    }
    recordWorktreeArtifact(agentId, {
      status: 'preserved',
      path: worktreePath,
      branch: branchName,
      repoPath,
      changedFiles: parseGitStatusPorcelain(statusOutput),
      diffSummary: diffOutput.trim(),
      evidenceRefs: [makeWorktreeEvidenceRef(agentId, worktreePath, 'diff')],
    });
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
    recordWorktreeArtifact(agentId, {
      status: 'error',
      path: worktreePath,
      branch: branchName,
      repoPath,
      error: err instanceof Error ? err.message : String(err),
    });
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

    // `git worktree list` reports resolved real paths; on macOS the managed base
    // dir (/tmp/...) resolves to /private/tmp/... So match against both the literal
    // base dir and its realpath, otherwise orphan cleanup is a no-op on macOS.
    const baseDirCandidates = [WORKTREE_BASE_DIR];
    try {
      const real = fs.realpathSync(WORKTREE_BASE_DIR);
      if (real !== WORKTREE_BASE_DIR) baseDirCandidates.push(real);
    } catch {
      // base dir may not exist yet — literal prefix is enough
    }

    for (const entry of entries) {
      const pathMatch = entry.match(/^worktree\s+(.+)$/m);
      const branchMatch = entry.match(/^branch\s+refs\/heads\/(.+)$/m);
      if (!pathMatch) continue;

      const wtPath = pathMatch[1];
      const branchName = branchMatch?.[1];

      // 3. Only clean worktrees in our managed directory
      if (!baseDirCandidates.some(base => wtPath.startsWith(base))) continue;

      // 4. Check directory mtime
      try {
        const stat = fs.statSync(wtPath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs < maxAgeMs) continue;
      } catch {
        // Directory doesn't exist on disk — git still references it, force remove
      }

      // 5. Capture a patch before force-removing, so any uncommitted work in a
      //    stale/orphaned worktree isn't silently lost. best-effort; if the
      //    worktree dir is already gone captureWorkspacePatch returns null.
      const orphanAgentId = branchName?.startsWith('agent/')
        ? branchName.slice('agent/'.length)
        : path.basename(wtPath);
      try {
        await captureWorkspacePatch(wtPath, orphanAgentId, 'worktree-cleanup');
      } catch (err) {
        logger.warn(`[OrphanCleanup] captureWorkspacePatch failed for ${wtPath}:`, err);
      }

      // 6. Remove the orphaned worktree
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

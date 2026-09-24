import { promises as fsp } from 'fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceDirectorySummary } from '../../shared/contract/workspace';
import { canonicalizeWorkspacePath } from '../runtime/workspaceScope';
import { SESSION_LIST_PAGE_SIZE } from '../../shared/constants';

const execFileAsync = promisify(execFile);

export async function handleGetDirectorySummary(payload: { dir?: string }): Promise<WorkspaceDirectorySummary> {
  const directory = payload.dir?.trim() ?? '';
  const summary: WorkspaceDirectorySummary = {
    path: directory,
    exists: false,
    isDirectory: false,
    git: { isRepository: false, branch: null, dirtyFiles: 0, ahead: 0, behind: 0 },
    recentSessionCount: 0,
  };
  if (!directory) return summary;

  try {
    const info = await fsp.stat(directory);
    summary.exists = true;
    summary.isDirectory = info.isDirectory();
  } catch {
    return summary;
  }
  if (!summary.isDirectory) return summary;

  try {
    const [repositoryRoot, branch, status, counts] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, timeout: 5000 }),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: directory, timeout: 5000 }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: directory, timeout: 5000 }),
      execFileAsync('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], {
        cwd: directory,
        timeout: 5000,
      }).catch(() => ({ stdout: '0 0' })),
    ]);
    if (repositoryRoot.stdout.trim()) {
      const [behind = 0, ahead = 0] = counts.stdout.trim().split(/\s+/).map(Number);
      summary.git = {
        isRepository: true,
        branch: branch.stdout.trim() || null,
        dirtyFiles: status.stdout.split('\n').filter(Boolean).length,
        ahead,
        behind,
      };
    }
  } catch {
    // A readable directory is still useful when git is unavailable or not initialized.
  }

  try {
    const { getSessionManager } = await import('../services/infra/sessionManager');
    const sessions = await getSessionManager().listSessions({ limit: SESSION_LIST_PAGE_SIZE });
    const normalizedDirectory = canonicalizeWorkspacePath(directory);
    summary.recentSessionCount = sessions.filter((session) => {
      if (!session.workingDirectory) return false;
      try {
        return canonicalizeWorkspacePath(session.workingDirectory) === normalizedDirectory;
      } catch {
        return false;
      }
    }).length;
  } catch {
    // Database/session service may be unavailable during startup.
  }

  return summary;
}

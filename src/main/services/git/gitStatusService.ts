// ============================================================================
// Git Status Service - 自动刷新 Git 状态到渲染进程
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from '../../platform';
import { createLogger } from '../infra/logger';

const execAsync = promisify(exec);
const logger = createLogger('GitStatusService');

// 需要触发 git 状态刷新的工具（修改文件的工具）
const FILE_MODIFYING_TOOLS = new Set([
  'Bash',
  'Write',
  'Edit',
]);

interface GitStatus {
  branch: string | null;
  changes: { staged: number; unstaged: number; untracked: number } | null;
}

class GitStatusService {
  private pendingRefresh: NodeJS.Timeout | null = null;
  private static readonly DEBOUNCE_MS = 500; // 防抖 500ms

  /**
   * 工具执行后调用，根据工具类型决定是否刷新 git 状态
   */
  onPostToolUse(toolName: string, workingDirectory: string): void {
    if (!FILE_MODIFYING_TOOLS.has(toolName)) return;

    // 防抖：多个工具快速连续执行时只刷新一次
    if (this.pendingRefresh) {
      clearTimeout(this.pendingRefresh);
    }

    this.pendingRefresh = setTimeout(() => {
      this.pendingRefresh = null;
      this.refresh(workingDirectory).catch(err => {
        logger.debug('Git status refresh failed', { error: err });
      });
    }, GitStatusService.DEBOUNCE_MS);
  }

  /**
   * 立即刷新 git 状态并推送到所有渲染进程窗口
   */
  async refresh(workingDirectory: string): Promise<GitStatus> {
    const status = await this.getGitStatus(workingDirectory);

    // 推送到所有 BrowserWindow
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('status:git-update', status);
      }
    }

    return status;
  }

  /**
   * 获取 git 状态（branch + changes）
   */
  private async getGitStatus(workingDirectory: string): Promise<GitStatus> {
    try {
      const [branchResult, statusResult] = await Promise.all([
        execAsync('git rev-parse --abbrev-ref HEAD', {
          cwd: workingDirectory,
          timeout: 5000,
        }).then(({ stdout }) => stdout.trim()).catch(() => null),
        execAsync('git status --porcelain', {
          cwd: workingDirectory,
          timeout: 5000,
        }).then(({ stdout }) => stdout).catch(() => null),
      ]);

      let changes: { staged: number; unstaged: number; untracked: number } | null = null;
      if (statusResult !== null) {
        const lines = statusResult.trim().split('\n').filter(Boolean);
        let staged = 0, unstaged = 0, untracked = 0;

        for (const line of lines) {
          const index = line[0];
          const worktree = line[1];
          if (index === '?' && worktree === '?') {
            untracked++;
          } else {
            if (index !== ' ' && index !== '?') staged++;
            if (worktree !== ' ' && worktree !== '?') unstaged++;
          }
        }

        changes = { staged, unstaged, untracked };
      }

      return { branch: branchResult, changes };
    } catch {
      return { branch: null, changes: null };
    }
  }

  /**
   * 清理
   */
  destroy(): void {
    if (this.pendingRefresh) {
      clearTimeout(this.pendingRefresh);
      this.pendingRefresh = null;
    }
  }
}

// Singleton
let instance: GitStatusService | null = null;

export function getGitStatusService(): GitStatusService {
  if (!instance) {
    instance = new GitStatusService();
  }
  return instance;
}

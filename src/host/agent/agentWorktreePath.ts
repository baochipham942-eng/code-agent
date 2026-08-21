import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const WORKTREE_BASE_DIR = path.join(os.tmpdir(), 'code-agent-worktrees');

export function isAgentWorktreePath(cwd: string): boolean {
  const resolvedBase = fs.existsSync(WORKTREE_BASE_DIR)
    ? fs.realpathSync(WORKTREE_BASE_DIR)
    : path.resolve(WORKTREE_BASE_DIR);
  const resolvedCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
  const relative = path.relative(resolvedBase, resolvedCwd);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

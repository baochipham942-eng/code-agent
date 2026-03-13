// ============================================================================
// Git Worktree Tool - 工作树管理
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NETWORK_TOOL_TIMEOUTS } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';
import * as path from 'path';

const execAsync = promisify(exec);
const logger = createLogger('GitWorktree');

interface GitWorktreeParams {
  action: 'list' | 'add' | 'remove' | 'prune';
  // add
  path?: string;
  branch?: string;
  new_branch?: string;
  base?: string;
  // remove
  force?: boolean;
}

async function execGit(
  command: string,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, { cwd, timeout: NETWORK_TOOL_TIMEOUTS.GIT_OPERATION });
}

function escapeShellArg(arg: string): string {
  return arg.replace(/'/g, "'\\''");
}

// ----------------------------------------------------------------------------
// Action Handlers
// ----------------------------------------------------------------------------

async function handleList(
  _params: GitWorktreeParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  const { stdout } = await execGit('git worktree list --porcelain', cwd);

  if (!stdout.trim()) {
    return { success: true, output: '没有工作树。' };
  }

  // Parse porcelain output
  const worktrees: Array<{ path: string; head: string; branch: string; bare?: boolean }> = [];
  let current: Record<string, string> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push({ path: current.path, head: current.head || '', branch: current.branch || '(detached)' });
      current = { path: line.substring(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.substring(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.substring(7).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.branch = '(bare)';
    } else if (line === '' && current.path) {
      worktrees.push({ path: current.path, head: current.head || '', branch: current.branch || '(detached)' });
      current = {};
    }
  }
  if (current.path) {
    worktrees.push({ path: current.path, head: current.head || '', branch: current.branch || '(detached)' });
  }

  let output = `工作树列表 (${worktrees.length}):\n\n`;
  for (const wt of worktrees) {
    output += `**${wt.branch}**\n`;
    output += `  路径: ${wt.path}\n`;
    output += `  HEAD: ${wt.head.substring(0, 8)}\n\n`;
  }

  return {
    success: true,
    output,
    metadata: { count: worktrees.length, worktrees },
  };
}

async function handleAdd(
  params: GitWorktreeParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  // Determine worktree path
  let worktreePath = params.path;
  if (!worktreePath) {
    // Auto-generate path based on branch name
    const branchName = params.new_branch || params.branch || 'worktree';
    const safeName = branchName.replace(/[/\\]/g, '-');
    const repoName = path.basename(cwd);
    worktreePath = path.join(path.dirname(cwd), `${repoName}-${safeName}`);
  }

  const args: string[] = ['git', 'worktree', 'add'];

  if (params.new_branch) {
    // Create new branch from base
    args.push('-b', `'${escapeShellArg(params.new_branch)}'`);
    args.push(`'${escapeShellArg(worktreePath)}'`);
    if (params.base) {
      args.push(`'${escapeShellArg(params.base)}'`);
    }
  } else if (params.branch) {
    // Checkout existing branch
    args.push(`'${escapeShellArg(worktreePath)}'`, `'${escapeShellArg(params.branch)}'`);
  } else {
    return {
      success: false,
      error: '请指定 branch（检出已有分支）或 new_branch（创建新分支）。',
    };
  }

  context.emit?.('tool_output', {
    tool: 'git_worktree',
    message: `创建工作树: ${worktreePath}`,
  });

  const { stdout, stderr } = await execGit(args.join(' '), cwd);
  const output = (stdout + '\n' + stderr).trim();

  return {
    success: true,
    output: `工作树创建成功:\n路径: ${worktreePath}\n分支: ${params.new_branch || params.branch}\n\n${output}`,
    metadata: { path: worktreePath, branch: params.new_branch || params.branch },
  };
}

async function handleRemove(
  params: GitWorktreeParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  if (!params.path) {
    return { success: false, error: '缺少 path 参数（工作树路径）' };
  }

  // Remove 是破坏性操作，请求确认
  const permitted = await context.requestPermission({
    type: 'dangerous_command',
    tool: 'git_worktree',
    details: {
      action: 'remove',
      path: params.path,
      force: params.force ?? false,
    },
    reason: `删除工作树: ${params.path}`,
  });

  if (!permitted) {
    return { success: false, error: '用户取消了删除操作' };
  }

  const args: string[] = ['git', 'worktree', 'remove'];
  if (params.force) {
    args.push('--force');
  }
  args.push(`'${escapeShellArg(params.path)}'`);

  await execGit(args.join(' '), cwd);

  return {
    success: true,
    output: `工作树已删除: ${params.path}`,
    metadata: { path: params.path },
  };
}

async function handlePrune(
  _params: GitWorktreeParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  // 先 dry-run 看看有什么要清理的
  const { stdout: dryRun } = await execGit('git worktree prune --dry-run', cwd);

  if (!dryRun.trim()) {
    return { success: true, output: '没有需要清理的工作树引用。' };
  }

  await execGit('git worktree prune', cwd);

  return {
    success: true,
    output: `已清理过期的工作树引用:\n${dryRun.trim()}`,
  };
}

// ----------------------------------------------------------------------------
// Tool Definition
// ----------------------------------------------------------------------------

export const gitWorktreeTool: Tool = {
  name: 'git_worktree',
  description: `Git 工作树管理工具。创建、列出、删除和清理工作树。

工作树允许同时在多个分支上工作，每个工作树拥有独立的工作目录，共享同一个 .git 仓库。适用于并行任务处理场景。

**何时使用**: 需要在不切换分支的情况下同时处理多个任务、创建隔离的工作环境时。
**何时不用**: 简单的分支切换（用 Bash git checkout）、临时查看其他分支文件（用 git show）。

**使用示例**:

列出所有工作树:
\`\`\`
git_worktree { "action": "list" }
\`\`\`

从现有分支创建工作树:
\`\`\`
git_worktree { "action": "add", "branch": "feature/login" }
git_worktree { "action": "add", "branch": "hotfix/bug", "path": "/tmp/hotfix" }
\`\`\`

创建新分支的工作树:
\`\`\`
git_worktree { "action": "add", "new_branch": "feature/git-tools", "base": "main" }
\`\`\`

删除工作树（需要确认）:
\`\`\`
git_worktree { "action": "remove", "path": "/path/to/worktree" }
git_worktree { "action": "remove", "path": "/path/to/worktree", "force": true }
\`\`\`

清理过期引用:
\`\`\`
git_worktree { "action": "prune" }
\`\`\``,

  requiresPermission: true,
  permissionLevel: 'execute',

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'prune'],
        description: '操作类型',
      },
      path: {
        type: 'string',
        description: '工作树路径（action=add 时可选，自动生成；action=remove 时必填）',
      },
      branch: {
        type: 'string',
        description: '检出的已有分支名（action=add）',
      },
      new_branch: {
        type: 'string',
        description: '要创建的新分支名（action=add，与 branch 互斥）',
      },
      base: {
        type: 'string',
        description: '新分支的基准（action=add + new_branch，默认当前 HEAD）',
      },
      force: {
        type: 'boolean',
        description: '强制删除（action=remove，即使有未提交更改）',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const p = params as unknown as GitWorktreeParams;

    try {
      switch (p.action) {
        case 'list':
          return await handleList(p, context);
        case 'add':
          return await handleAdd(p, context);
        case 'remove':
          return await handleRemove(p, context);
        case 'prune':
          return await handlePrune(p, context);
        default:
          return { success: false, error: `未知操作: ${p.action}` };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Git worktree operation failed', { action: p.action, error: message });
      return {
        success: false,
        error: `Git worktree 操作失败: ${message}`,
      };
    }
  },
};

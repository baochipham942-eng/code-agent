// ============================================================================
// Git Commit Tool - 结构化的 Git 提交操作
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NETWORK_TOOL_TIMEOUTS } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';

const execAsync = promisify(exec);
const logger = createLogger('GitCommit');

interface GitCommitParams {
  action: 'status' | 'add' | 'commit' | 'push' | 'log';
  // add
  files?: string[];
  all?: boolean;
  // commit
  message?: string;
  amend?: boolean;
  // push
  remote?: string;
  branch?: string;
  set_upstream?: boolean;
  // log
  limit?: number;
  oneline?: boolean;
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

async function handleStatus(
  _params: GitCommitParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  const [statusResult, branchResult] = await Promise.all([
    execGit('git status --porcelain', cwd),
    execGit('git branch --show-current', cwd).catch(() => ({ stdout: '', stderr: '' })),
  ]);

  const branch = branchResult.stdout.trim() || '(detached)';
  const lines = statusResult.stdout.trim().split('\n').filter(Boolean);

  if (lines.length === 0) {
    return {
      success: true,
      output: `分支: ${branch}\n工作区干净，没有未提交的更改。`,
      metadata: { branch, clean: true, staged: 0, unstaged: 0, untracked: 0 },
    };
  }

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  const stagedFiles: string[] = [];
  const unstagedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const line of lines) {
    const index = line[0];
    const worktree = line[1];
    const file = line.substring(3);

    if (index === '?' && worktree === '?') {
      untracked++;
      untrackedFiles.push(file);
    } else {
      if (index !== ' ' && index !== '?') {
        staged++;
        stagedFiles.push(`${index} ${file}`);
      }
      if (worktree !== ' ' && worktree !== '?') {
        unstaged++;
        unstagedFiles.push(`${worktree} ${file}`);
      }
    }
  }

  let output = `分支: ${branch}\n\n`;
  if (stagedFiles.length > 0) {
    output += `**已暂存** (${staged}):\n${stagedFiles.map(f => `  ${f}`).join('\n')}\n\n`;
  }
  if (unstagedFiles.length > 0) {
    output += `**未暂存** (${unstaged}):\n${unstagedFiles.map(f => `  ${f}`).join('\n')}\n\n`;
  }
  if (untrackedFiles.length > 0) {
    output += `**未跟踪** (${untracked}):\n${untrackedFiles.map(f => `  ${f}`).join('\n')}\n`;
  }

  return {
    success: true,
    output,
    metadata: { branch, clean: false, staged, unstaged, untracked },
  };
}

async function handleAdd(
  params: GitCommitParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  if (params.all) {
    await execGit('git add -A', cwd);
    return { success: true, output: '已暂存所有更改。' };
  }

  if (!params.files || params.files.length === 0) {
    return { success: false, error: '请指定要暂存的文件，或使用 all: true 暂存全部。' };
  }

  // 安全检查：敏感文件警告
  const sensitivePatterns = ['.env', 'credentials', '.pem', '_secret', '.key'];
  const sensitiveFiles = params.files.filter(f =>
    sensitivePatterns.some(p => f.toLowerCase().includes(p))
  );
  if (sensitiveFiles.length > 0) {
    return {
      success: false,
      error: `⚠️ 检测到可能包含密钥的文件: ${sensitiveFiles.join(', ')}。确认需要提交请使用 Bash 工具手动执行 git add。`,
    };
  }

  const fileArgs = params.files.map(f => `'${escapeShellArg(f)}'`).join(' ');
  await execGit(`git add ${fileArgs}`, cwd);

  return {
    success: true,
    output: `已暂存 ${params.files.length} 个文件:\n${params.files.map(f => `  + ${f}`).join('\n')}`,
    metadata: { files: params.files },
  };
}

async function handleCommit(
  params: GitCommitParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  if (!params.message) {
    return { success: false, error: '缺少 message 参数（提交信息）' };
  }

  // amend 安全检查
  if (params.amend) {
    try {
      const { stdout } = await execGit('git status', cwd);
      if (stdout.includes('Your branch is ahead')) {
        // 未推送，允许 amend
      } else if (stdout.includes('up to date')) {
        return {
          success: false,
          error: '上一次提交已推送到远程，amend 会导致历史不一致。请创建新提交。',
        };
      }
    } catch {
      // 无法判断，保守处理
    }
  }

  const args: string[] = ['git', 'commit'];
  if (params.amend) {
    args.push('--amend');
  }
  args.push('-m', `'${escapeShellArg(params.message)}'`);

  const { stdout } = await execGit(args.join(' '), cwd);

  return {
    success: true,
    output: `提交成功:\n${stdout.trim()}`,
    metadata: { amend: params.amend ?? false },
  };
}

async function handlePush(
  params: GitCommitParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  // Push 是影响远程的操作，请求确认
  const permitted = await context.requestPermission({
    type: 'dangerous_command',
    tool: 'git_commit',
    details: {
      action: 'push',
      remote: params.remote || 'origin',
      branch: params.branch,
    },
    reason: '推送代码到远程仓库',
  });

  if (!permitted) {
    return { success: false, error: '用户取消了推送操作' };
  }

  const args: string[] = ['git', 'push'];
  if (params.set_upstream) {
    args.push('-u');
  }
  if (params.remote) {
    args.push(params.remote);
  }
  if (params.branch) {
    args.push(params.branch);
  }

  const { stdout, stderr } = await execGit(args.join(' '), cwd);
  const output = (stdout + '\n' + stderr).trim();

  return {
    success: true,
    output: `推送成功:\n${output}`,
  };
}

async function handleLog(
  params: GitCommitParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;
  const limit = params.limit || 10;

  const format = params.oneline
    ? `git log --oneline --no-decorate -${limit}`
    : `git log --format='%h %s (%an, %ar)' -${limit}`;

  const { stdout } = await execGit(format, cwd);

  return {
    success: true,
    output: stdout.trim() || '没有提交记录。',
    metadata: { limit },
  };
}

// ----------------------------------------------------------------------------
// Tool Definition
// ----------------------------------------------------------------------------

export const gitCommitTool: Tool = {
  name: 'git_commit',
  description: `Git 提交管理工具。查看状态、暂存文件、提交、推送和查看日志。

**何时使用**: 需要执行 Git 提交相关操作时 — 替代在 Bash 中手动拼 git 命令。
**何时不用**: PR 操作（用 github_pr）、Worktree 操作（用 git_worktree）、复杂 Git 操作（用 Bash）。

**使用示例**:

查看工作区状态:
\`\`\`
git_commit { "action": "status" }
\`\`\`

暂存文件:
\`\`\`
git_commit { "action": "add", "files": ["src/main.ts", "src/utils.ts"] }
git_commit { "action": "add", "all": true }
\`\`\`

提交:
\`\`\`
git_commit { "action": "commit", "message": "feat: add git tools" }
\`\`\`

推送（需要确认）:
\`\`\`
git_commit { "action": "push" }
git_commit { "action": "push", "set_upstream": true, "branch": "feature/git" }
\`\`\`

查看提交日志:
\`\`\`
git_commit { "action": "log", "limit": 5, "oneline": true }
\`\`\``,

  requiresPermission: true,
  permissionLevel: 'execute',

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'add', 'commit', 'push', 'log'],
        description: '操作类型',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: '要暂存的文件列表（action=add）',
      },
      all: {
        type: 'boolean',
        description: '是否暂存所有更改（action=add）',
      },
      message: {
        type: 'string',
        description: '提交信息（action=commit）',
      },
      amend: {
        type: 'boolean',
        description: '是否修改上一次提交（action=commit, 默认 false）',
      },
      remote: {
        type: 'string',
        description: '远程仓库名（action=push, 默认 origin）',
      },
      branch: {
        type: 'string',
        description: '推送的分支名（action=push）',
      },
      set_upstream: {
        type: 'boolean',
        description: '是否设置上游跟踪（action=push）',
      },
      limit: {
        type: 'number',
        description: '日志条目数量（action=log, 默认 10）',
      },
      oneline: {
        type: 'boolean',
        description: '是否使用单行格式（action=log）',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const p = params as unknown as GitCommitParams;

    try {
      switch (p.action) {
        case 'status':
          return await handleStatus(p, context);
        case 'add':
          return await handleAdd(p, context);
        case 'commit':
          return await handleCommit(p, context);
        case 'push':
          return await handlePush(p, context);
        case 'log':
          return await handleLog(p, context);
        default:
          return { success: false, error: `未知操作: ${p.action}` };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Git commit operation failed', { action: p.action, error: message });
      return {
        success: false,
        error: `Git 操作失败: ${message}`,
      };
    }
  },
};

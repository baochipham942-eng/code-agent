// ============================================================================
// Git Diff Tool - 结构化的 Git 差异分析
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NETWORK_TOOL_TIMEOUTS } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';

const execAsync = promisify(exec);
const logger = createLogger('GitDiff');

interface GitDiffParams {
  action: 'diff' | 'diff_staged' | 'diff_branch' | 'show';
  // diff / diff_staged
  files?: string[];
  stat_only?: boolean;
  // diff_branch
  base?: string;
  head?: string;
  // show
  commit?: string;
}

async function execGit(
  command: string,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, {
    cwd,
    timeout: NETWORK_TOOL_TIMEOUTS.GIT_OPERATION,
    maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
  });
}

const MAX_DIFF_LENGTH = 50_000;

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_LENGTH) return diff;
  return (
    diff.substring(0, MAX_DIFF_LENGTH) +
    `\n\n[差异内容过长，已截断。原始 ${diff.length} 字符，显示前 ${MAX_DIFF_LENGTH} 字符。请使用 files 参数缩小范围。]`
  );
}

// ----------------------------------------------------------------------------
// Action Handlers
// ----------------------------------------------------------------------------

async function handleDiff(
  params: GitDiffParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;
  const args: string[] = ['git', 'diff'];

  if (params.stat_only) {
    args.push('--stat');
  }
  if (params.files && params.files.length > 0) {
    args.push('--', ...params.files);
  }

  const { stdout } = await execGit(args.join(' '), cwd);

  if (!stdout.trim()) {
    return { success: true, output: '没有未暂存的更改。' };
  }

  return {
    success: true,
    output: truncateDiff(stdout),
    metadata: { type: 'unstaged' },
  };
}

async function handleDiffStaged(
  params: GitDiffParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;
  const args: string[] = ['git', 'diff', '--cached'];

  if (params.stat_only) {
    args.push('--stat');
  }
  if (params.files && params.files.length > 0) {
    args.push('--', ...params.files);
  }

  const { stdout } = await execGit(args.join(' '), cwd);

  if (!stdout.trim()) {
    return { success: true, output: '没有已暂存的更改。' };
  }

  return {
    success: true,
    output: truncateDiff(stdout),
    metadata: { type: 'staged' },
  };
}

async function handleDiffBranch(
  params: GitDiffParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  const base = params.base || 'main';
  const head = params.head || 'HEAD';

  const args: string[] = ['git', 'diff'];
  if (params.stat_only) {
    args.push('--stat');
  }
  args.push(`${base}...${head}`);

  if (params.files && params.files.length > 0) {
    args.push('--', ...params.files);
  }

  const { stdout } = await execGit(args.join(' '), cwd);

  if (!stdout.trim()) {
    return { success: true, output: `${base} 和 ${head} 之间没有差异。` };
  }

  return {
    success: true,
    output: truncateDiff(stdout),
    metadata: { type: 'branch', base, head },
  };
}

async function handleShow(
  params: GitDiffParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;
  const commit = params.commit || 'HEAD';

  const args: string[] = ['git', 'show'];
  if (params.stat_only) {
    args.push('--stat');
  }
  args.push(commit);

  const { stdout } = await execGit(args.join(' '), cwd);

  return {
    success: true,
    output: truncateDiff(stdout),
    metadata: { type: 'show', commit },
  };
}

// ----------------------------------------------------------------------------
// Tool Definition
// ----------------------------------------------------------------------------

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description: `Git 差异分析工具。查看未暂存/已暂存/跨分支差异和特定提交内容。

**何时使用**: 需要分析代码变更时 — 替代在 Bash 中拼 git diff/show 命令。输出带结构化 metadata，可被 UI 渲染。
**何时不用**: 简单的 git status（用 git_commit）、PR 相关差异（用 github_pr view）。

**使用示例**:

查看未暂存的更改:
\`\`\`
git_diff { "action": "diff" }
git_diff { "action": "diff", "files": ["src/main.ts"], "stat_only": true }
\`\`\`

查看已暂存的更改:
\`\`\`
git_diff { "action": "diff_staged" }
\`\`\`

查看跨分支差异:
\`\`\`
git_diff { "action": "diff_branch", "base": "main", "head": "feature/git" }
git_diff { "action": "diff_branch", "stat_only": true }
\`\`\`

查看特定提交:
\`\`\`
git_diff { "action": "show", "commit": "abc1234" }
git_diff { "action": "show", "stat_only": true }
\`\`\``,

  requiresPermission: false,
  permissionLevel: 'execute',

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['diff', 'diff_staged', 'diff_branch', 'show'],
        description: '操作类型: diff(未暂存), diff_staged(已暂存), diff_branch(跨分支), show(特定提交)',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: '限定文件范围（action=diff/diff_staged/diff_branch）',
      },
      stat_only: {
        type: 'boolean',
        description: '只显示统计摘要，不显示具体差异（默认 false）',
      },
      base: {
        type: 'string',
        description: '基准分支（action=diff_branch, 默认 main）',
      },
      head: {
        type: 'string',
        description: '目标分支（action=diff_branch, 默认 HEAD）',
      },
      commit: {
        type: 'string',
        description: '提交哈希（action=show, 默认 HEAD）',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const p = params as unknown as GitDiffParams;

    try {
      switch (p.action) {
        case 'diff':
          return await handleDiff(p, context);
        case 'diff_staged':
          return await handleDiffStaged(p, context);
        case 'diff_branch':
          return await handleDiffBranch(p, context);
        case 'show':
          return await handleShow(p, context);
        default:
          return { success: false, error: `未知操作: ${p.action}` };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Git diff operation failed', { action: p.action, error: message });
      return {
        success: false,
        error: `Git diff 操作失败: ${message}`,
      };
    }
  },
};

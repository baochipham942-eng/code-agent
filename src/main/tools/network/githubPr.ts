// ============================================================================
// GitHub PR Tool - GitHub Pull Request 管理
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getPRLinkService } from '../../services/github/prLinkService';
import { createLogger } from '../../services/infra/logger';
import { NETWORK_TOOL_TIMEOUTS } from '../../../shared/constants';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const logger = createLogger('GitHubPR');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface GitHubPRParams {
  action: 'create' | 'view' | 'list' | 'comment' | 'review' | 'merge';
  // create
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
  labels?: string[];
  // view / comment / review / merge
  pr?: string | number;
  // list
  state?: 'open' | 'closed' | 'merged' | 'all';
  author?: string;
  label?: string;
  limit?: number;
  // comment
  // (uses body)
  // review
  event?: 'approve' | 'request-changes' | 'comment';
  // merge
  method?: 'merge' | 'squash' | 'rebase';
  delete_branch?: boolean;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function execGh(
  command: string,
  cwd: string
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, { cwd, timeout: NETWORK_TOOL_TIMEOUTS.HTTP_DEFAULT });
}

async function checkGhInstalled(cwd: string): Promise<string | null> {
  try {
    await execGh('gh --version', cwd);
    return null;
  } catch {
    return 'gh CLI 未安装。请先安装：brew install gh && gh auth login';
  }
}

async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execGh('git branch --show-current', cwd);
  return stdout.trim();
}

async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const { stdout } = await execGh('git status --porcelain', cwd);
  return stdout.trim().length > 0;
}

async function isUpstreamConfigured(cwd: string, branch: string): Promise<boolean> {
  try {
    await execGh(`git rev-parse --abbrev-ref ${branch}@{upstream}`, cwd);
    return true;
  } catch {
    return false;
  }
}

async function getCommitLog(cwd: string, base: string): Promise<string[]> {
  try {
    const { stdout } = await execGh(
      `git log ${base}..HEAD --oneline --no-decorate`,
      cwd
    );
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function detectBaseBranch(cwd: string): Promise<string> {
  for (const candidate of ['main', 'master']) {
    try {
      await execGh(`git rev-parse --verify ${candidate}`, cwd);
      return candidate;
    } catch {
      // try next
    }
  }
  return 'main';
}

function escapeShellArg(arg: string): string {
  return arg.replace(/'/g, "'\\''");
}

// ----------------------------------------------------------------------------
// Action Handlers
// ----------------------------------------------------------------------------

async function handleCreate(
  params: GitHubPRParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  // 1. Check current branch
  const branch = await getCurrentBranch(cwd);
  if (branch === 'main' || branch === 'master') {
    return {
      success: false,
      error: `当前在 ${branch} 分支，不能从默认分支创建 PR。请先切换到功能分支。`,
    };
  }

  // 2. Check uncommitted changes
  if (await hasUncommittedChanges(cwd)) {
    return {
      success: false,
      error: '有未提交的更改。请先 commit 后再创建 PR。',
    };
  }

  // 3. Push if not yet pushed
  if (!(await isUpstreamConfigured(cwd, branch))) {
    context.emit?.('tool_output', {
      tool: 'github_pr',
      message: `推送分支 ${branch} 到远程...`,
    });
    await execGh(`git push -u origin ${branch}`, cwd);
  }

  // 4. Detect base branch
  const base = params.base || (await detectBaseBranch(cwd));

  // 5. Generate default title/body from commit log
  const commits = await getCommitLog(cwd, base);

  let title = params.title;
  let body = params.body;

  if (!title && commits.length > 0) {
    // Use first commit message (without hash) as title
    title = commits[0].replace(/^[a-f0-9]+ /, '');
  }
  title = title || branch;

  if (!body && commits.length > 0) {
    body = '## Commits\n\n' + commits.map((c) => `- ${c}`).join('\n');
  }

  // 6. Build gh pr create command
  const args: string[] = [
    'gh', 'pr', 'create',
    '--title', `'${escapeShellArg(title)}'`,
    '--body', `'${escapeShellArg(body || '')}'`,
    '--base', base,
  ];

  if (params.draft) {
    args.push('--draft');
  }

  if (params.labels && params.labels.length > 0) {
    for (const label of params.labels) {
      args.push('--label', `'${escapeShellArg(label)}'`);
    }
  }

  context.emit?.('tool_output', {
    tool: 'github_pr',
    message: `创建 PR: ${title}`,
  });

  const { stdout } = await execGh(args.join(' '), cwd);
  const prUrl = stdout.trim();

  // 7. Link PR to session via PRLinkService
  try {
    const prLinkService = getPRLinkService();
    const parsed = prLinkService.parsePRUrl(prUrl);
    if (parsed) {
      const prContext = await prLinkService.fetchPRContext(
        parsed.owner,
        parsed.repo,
        parsed.number
      );
      if (prContext) {
        prLinkService.createPRLink(prContext);
      }
    }
  } catch (e) {
    // Non-critical, just log
    logger.warn('Failed to link PR to session', { error: e });
  }

  return {
    success: true,
    output: `PR 创建成功！\n\n**URL**: ${prUrl}\n**Title**: ${title}\n**Base**: ${base}\n**Branch**: ${branch}${params.draft ? '\n**Draft**: Yes' : ''}`,
    metadata: { url: prUrl, title, base, branch },
  };
}

async function handleView(
  params: GitHubPRParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  const prRef = params.pr;
  if (!prRef) {
    return { success: false, error: '缺少 pr 参数（PR 编号或 URL）' };
  }

  context.emit?.('tool_output', {
    tool: 'github_pr',
    message: `查看 PR: ${prRef}`,
  });

  const { stdout } = await execGh(
    `gh pr view ${prRef} --json number,title,body,headRefName,baseRefName,state,changedFiles,additions,deletions,labels,url,author,reviewDecision,mergeable,comments`,
    cwd
  );

  const data = JSON.parse(stdout);

  let output = `## PR #${data.number}: ${data.title}\n\n`;
  output += `**URL**: ${data.url}\n`;
  output += `**Author**: ${data.author?.login || 'unknown'}\n`;
  output += `**Branch**: ${data.headRefName} -> ${data.baseRefName}\n`;
  output += `**State**: ${data.state}\n`;
  output += `**Changes**: +${data.additions} / -${data.deletions} in ${data.changedFiles} files\n`;

  if (data.labels?.length > 0) {
    output += `**Labels**: ${data.labels.map((l: { name: string }) => l.name).join(', ')}\n`;
  }

  if (data.reviewDecision) {
    output += `**Review**: ${data.reviewDecision}\n`;
  }

  if (data.mergeable) {
    output += `**Mergeable**: ${data.mergeable}\n`;
  }

  if (data.body) {
    output += `\n### Description\n\n${data.body}\n`;
  }

  if (data.comments?.length > 0) {
    output += `\n### Comments (${data.comments.length})\n\n`;
    for (const comment of data.comments.slice(-5)) {
      output += `**${comment.author?.login || 'unknown'}**: ${comment.body?.substring(0, 200) || ''}\n\n`;
    }
  }

  return {
    success: true,
    output,
    metadata: { number: data.number, url: data.url, state: data.state },
  };
}

async function handleList(
  params: GitHubPRParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  const args: string[] = ['gh', 'pr', 'list', '--json', 'number,title,state,headRefName,author,labels,url,updatedAt'];

  const state = params.state || 'open';
  if (state !== 'all') {
    args.push('--state', state);
  }

  if (params.author) {
    args.push('--author', params.author);
  }

  if (params.label) {
    args.push('--label', `'${escapeShellArg(params.label)}'`);
  }

  const limit = params.limit || 10;
  args.push('--limit', String(limit));

  context.emit?.('tool_output', {
    tool: 'github_pr',
    message: `列出 PR (${state})...`,
  });

  const { stdout } = await execGh(args.join(' '), cwd);
  const prs = JSON.parse(stdout);

  if (prs.length === 0) {
    return { success: true, output: '没有找到匹配的 PR' };
  }

  let output = `找到 ${prs.length} 个 PR:\n\n`;
  for (const pr of prs) {
    const labels = pr.labels?.map((l: { name: string }) => l.name).join(', ');
    output += `**#${pr.number}** ${pr.title}\n`;
    output += `  Branch: ${pr.headRefName} | Author: ${pr.author?.login || 'unknown'} | State: ${pr.state}`;
    if (labels) output += ` | Labels: ${labels}`;
    output += '\n\n';
  }

  return {
    success: true,
    output,
    metadata: { count: prs.length, prs: prs.map((p: any) => ({ number: p.number, title: p.title })) },
  };
}

async function handleComment(
  params: GitHubPRParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  if (!params.pr) {
    return { success: false, error: '缺少 pr 参数（PR 编号或 URL）' };
  }
  if (!params.body) {
    return { success: false, error: '缺少 body 参数（评论内容）' };
  }

  context.emit?.('tool_output', {
    tool: 'github_pr',
    message: `评论 PR #${params.pr}...`,
  });

  await execGh(
    `gh pr comment ${params.pr} --body '${escapeShellArg(params.body)}'`,
    cwd
  );

  return {
    success: true,
    output: `已在 PR #${params.pr} 添加评论。`,
    metadata: { pr: params.pr },
  };
}

async function handleReview(
  params: GitHubPRParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  if (!params.pr) {
    return { success: false, error: '缺少 pr 参数（PR 编号或 URL）' };
  }

  const event = params.event || 'comment';
  const args: string[] = ['gh', 'pr', 'review', String(params.pr)];

  switch (event) {
    case 'approve':
      args.push('--approve');
      break;
    case 'request-changes':
      args.push('--request-changes');
      break;
    case 'comment':
      args.push('--comment');
      break;
  }

  if (params.body) {
    args.push('--body', `'${escapeShellArg(params.body)}'`);
  }

  context.emit?.('tool_output', {
    tool: 'github_pr',
    message: `Review PR #${params.pr} (${event})...`,
  });

  await execGh(args.join(' '), cwd);

  return {
    success: true,
    output: `已提交 PR #${params.pr} 的 review (${event})。`,
    metadata: { pr: params.pr, event },
  };
}

async function handleMerge(
  params: GitHubPRParams,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const cwd = context.workingDirectory;

  if (!params.pr) {
    return { success: false, error: '缺少 pr 参数（PR 编号或 URL）' };
  }

  // Merge 是高风险操作，请求二次确认
  const permitted = await context.requestPermission({
    type: 'dangerous_command',
    tool: 'github_pr',
    details: {
      action: 'merge',
      pr: params.pr,
      method: params.method || 'merge',
      delete_branch: params.delete_branch ?? false,
    },
    reason: `合并 PR #${params.pr} 是不可逆操作`,
  });

  if (!permitted) {
    return { success: false, error: '用户取消了合并操作' };
  }

  const method = params.method || 'merge';
  const args: string[] = ['gh', 'pr', 'merge', String(params.pr)];

  switch (method) {
    case 'squash':
      args.push('--squash');
      break;
    case 'rebase':
      args.push('--rebase');
      break;
    default:
      args.push('--merge');
      break;
  }

  if (params.delete_branch) {
    args.push('--delete-branch');
  }

  context.emit?.('tool_output', {
    tool: 'github_pr',
    message: `合并 PR #${params.pr} (${method})...`,
  });

  const { stdout } = await execGh(args.join(' '), cwd);

  return {
    success: true,
    output: `PR #${params.pr} 已合并 (${method})。${params.delete_branch ? '远程分支已删除。' : ''}\n${stdout}`,
    metadata: { pr: params.pr, method, deleted: params.delete_branch },
  };
}

// ----------------------------------------------------------------------------
// Tool Definition
// ----------------------------------------------------------------------------

export const githubPrTool: Tool = {
  name: 'github_pr',
  description: `GitHub Pull Request 管理工具。创建、查看、列出、评论、审查和合并 PR。

**前置条件**: 需要安装 gh CLI 并完成登录 (brew install gh && gh auth login)。
工作目录必须是 Git 仓库。

**何时使用**: 需要与 GitHub PR 交互时 — 创建新 PR、查看 PR 详情、列出仓库 PR、添加评论或 review、合并 PR。
**何时不用**: 仅需查看本地 Git 信息（用 bash + git 命令）、操作 GitHub Issues（用 bash + gh issue）。

**使用示例**:

创建 PR（自动检测分支、推送、生成标题）:
\`\`\`
github_pr { "action": "create" }
github_pr { "action": "create", "title": "Add login feature", "base": "develop", "draft": true }
\`\`\`

查看 PR:
\`\`\`
github_pr { "action": "view", "pr": 42 }
github_pr { "action": "view", "pr": "https://github.com/owner/repo/pull/42" }
\`\`\`

列出 PR:
\`\`\`
github_pr { "action": "list" }
github_pr { "action": "list", "state": "closed", "author": "octocat", "limit": 5 }
\`\`\`

评论 PR:
\`\`\`
github_pr { "action": "comment", "pr": 42, "body": "LGTM!" }
\`\`\`

Review PR:
\`\`\`
github_pr { "action": "review", "pr": 42, "event": "approve", "body": "Looks good" }
\`\`\`

合并 PR（需要二次确认）:
\`\`\`
github_pr { "action": "merge", "pr": 42, "method": "squash", "delete_branch": true }
\`\`\``,
  requiresPermission: true,
  permissionLevel: 'network',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'view', 'list', 'comment', 'review', 'merge'],
        description: '操作类型',
      },
      title: {
        type: 'string',
        description: 'PR 标题（action=create, 不提供则从 commit 生成）',
      },
      body: {
        type: 'string',
        description: 'PR 描述或评论内容（action=create/comment/review）',
      },
      base: {
        type: 'string',
        description: '目标分支（action=create, 默认自动检测 main/master）',
      },
      draft: {
        type: 'boolean',
        description: '是否创建为 Draft PR（action=create）',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: '标签列表（action=create）',
      },
      pr: {
        type: 'string',
        description: 'PR 编号或 URL（action=view/comment/review/merge, 如 "42" 或 "https://github.com/owner/repo/pull/42"）',
      },
      state: {
        type: 'string',
        enum: ['open', 'closed', 'merged', 'all'],
        description: 'PR 状态筛选（action=list, 默认 open）',
      },
      author: {
        type: 'string',
        description: '作者筛选（action=list）',
      },
      label: {
        type: 'string',
        description: '标签筛选（action=list）',
      },
      limit: {
        type: 'number',
        description: '最大返回数量（action=list, 默认 10）',
      },
      event: {
        type: 'string',
        enum: ['approve', 'request-changes', 'comment'],
        description: 'Review 类型（action=review, 默认 comment）',
      },
      method: {
        type: 'string',
        enum: ['merge', 'squash', 'rebase'],
        description: '合并方式（action=merge, 默认 merge）',
      },
      delete_branch: {
        type: 'boolean',
        description: '合并后是否删除远程分支（action=merge）',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const p = params as unknown as GitHubPRParams;
    const cwd = context.workingDirectory;

    // Check gh CLI
    const ghError = await checkGhInstalled(cwd);
    if (ghError) {
      return { success: false, error: ghError };
    }

    try {
      switch (p.action) {
        case 'create':
          return await handleCreate(p, context);
        case 'view':
          return await handleView(p, context);
        case 'list':
          return await handleList(p, context);
        case 'comment':
          return await handleComment(p, context);
        case 'review':
          return await handleReview(p, context);
        case 'merge':
          return await handleMerge(p, context);
        default:
          return { success: false, error: `未知操作: ${p.action}` };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('GitHub PR operation failed', { action: p.action, error: message });
      return {
        success: false,
        error: `GitHub PR 操作失败: ${message}`,
      };
    }
  },
};

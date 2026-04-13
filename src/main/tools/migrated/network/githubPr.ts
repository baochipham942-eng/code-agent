// ============================================================================
// github_pr (P0-6.3 Batch 9 — network: native ToolModule rewrite)
//
// GitHub Pull Request 管理：通过 gh CLI 创建/查看/列出/评论/审查/合并 PR。
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { getPRLinkService } from '../../../services/github/prLinkService';
import { NETWORK_TOOL_TIMEOUTS } from '../../../../shared/constants';

const execAsync = promisify(exec);

interface GitHubPRParams {
  action: 'create' | 'view' | 'list' | 'comment' | 'review' | 'merge';
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
  labels?: string[];
  pr?: string | number;
  state?: 'open' | 'closed' | 'merged' | 'all';
  author?: string;
  label?: string;
  limit?: number;
  event?: 'approve' | 'request-changes' | 'comment';
  method?: 'merge' | 'squash' | 'rebase';
  delete_branch?: boolean;
}

const schema: ToolSchema = {
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
        description: 'PR 编号或 URL（action=view/comment/review/merge）',
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
  category: 'network',
  permissionLevel: 'network',
  readOnly: false,
  allowInPlanMode: false,
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

async function execGh(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
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
    const { stdout } = await execGh(`git log ${base}..HEAD --oneline --no-decorate`, cwd);
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

// ─────────────────────────────────────────────────────────────────────────
// Action Handlers
// ─────────────────────────────────────────────────────────────────────────

async function handleCreate(
  params: GitHubPRParams,
  ctx: ToolContext,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const cwd = ctx.workingDir;

  const branch = await getCurrentBranch(cwd);
  if (branch === 'main' || branch === 'master') {
    return {
      ok: false,
      error: `当前在 ${branch} 分支，不能从默认分支创建 PR。请先切换到功能分支。`,
      code: 'INVALID_ARGS',
    };
  }

  if (await hasUncommittedChanges(cwd)) {
    return { ok: false, error: '有未提交的更改。请先 commit 后再创建 PR。', code: 'INVALID_ARGS' };
  }

  if (!(await isUpstreamConfigured(cwd, branch))) {
    onProgress?.({ stage: 'running', detail: `推送分支 ${branch} 到远程...` });
    await execGh(`git push -u origin ${branch}`, cwd);
  }

  const base = params.base || (await detectBaseBranch(cwd));
  const commits = await getCommitLog(cwd, base);

  let title = params.title;
  let body = params.body;

  if (!title && commits.length > 0) {
    title = commits[0].replace(/^[a-f0-9]+ /, '');
  }
  title = title || branch;

  if (!body && commits.length > 0) {
    body = '## Commits\n\n' + commits.map((c) => `- ${c}`).join('\n');
  }

  const argv: string[] = [
    'gh', 'pr', 'create',
    '--title', `'${escapeShellArg(title)}'`,
    '--body', `'${escapeShellArg(body || '')}'`,
    '--base', base,
  ];

  if (params.draft) {
    argv.push('--draft');
  }

  if (params.labels && params.labels.length > 0) {
    for (const label of params.labels) {
      argv.push('--label', `'${escapeShellArg(label)}'`);
    }
  }

  onProgress?.({ stage: 'running', detail: `创建 PR: ${title}` });

  const { stdout } = await execGh(argv.join(' '), cwd);
  const prUrl = stdout.trim();

  // Link PR to session via PRLinkService (best effort)
  try {
    const prLinkService = getPRLinkService();
    const parsed = prLinkService.parsePRUrl(prUrl);
    if (parsed) {
      const prContext = await prLinkService.fetchPRContext(parsed.owner, parsed.repo, parsed.number);
      if (prContext) {
        prLinkService.createPRLink(prContext);
      }
    }
  } catch (e) {
    ctx.logger.warn('Failed to link PR to session', { error: e });
  }

  return {
    ok: true,
    output: `PR 创建成功！\n\n**URL**: ${prUrl}\n**Title**: ${title}\n**Base**: ${base}\n**Branch**: ${branch}${params.draft ? '\n**Draft**: Yes' : ''}`,
    meta: { url: prUrl, title, base, branch },
  };
}

async function handleView(
  params: GitHubPRParams,
  ctx: ToolContext,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const cwd = ctx.workingDir;

  const prRef = params.pr;
  if (!prRef) {
    return { ok: false, error: '缺少 pr 参数（PR 编号或 URL）', code: 'INVALID_ARGS' };
  }

  onProgress?.({ stage: 'running', detail: `查看 PR: ${prRef}` });

  const { stdout } = await execGh(
    `gh pr view ${prRef} --json number,title,body,headRefName,baseRefName,state,changedFiles,additions,deletions,labels,url,author,reviewDecision,mergeable,comments`,
    cwd,
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
    ok: true,
    output,
    meta: { number: data.number, url: data.url, state: data.state },
  };
}

async function handleList(
  params: GitHubPRParams,
  ctx: ToolContext,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const cwd = ctx.workingDir;
  const argv: string[] = [
    'gh', 'pr', 'list',
    '--json', 'number,title,state,headRefName,author,labels,url,updatedAt',
  ];

  const state = params.state || 'open';
  if (state !== 'all') {
    argv.push('--state', state);
  }

  if (params.author) {
    argv.push('--author', params.author);
  }

  if (params.label) {
    argv.push('--label', `'${escapeShellArg(params.label)}'`);
  }

  const limit = params.limit || 10;
  argv.push('--limit', String(limit));

  onProgress?.({ stage: 'running', detail: `列出 PR (${state})...` });

  const { stdout } = await execGh(argv.join(' '), cwd);
  const prs = JSON.parse(stdout);

  if (prs.length === 0) {
    return { ok: true, output: '没有找到匹配的 PR' };
  }

  let output = `找到 ${prs.length} 个 PR:\n\n`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const pr of prs as any[]) {
    const labels = pr.labels?.map((l: { name: string }) => l.name).join(', ');
    output += `**#${pr.number}** ${pr.title}\n`;
    output += `  Branch: ${pr.headRefName} | Author: ${pr.author?.login || 'unknown'} | State: ${pr.state}`;
    if (labels) output += ` | Labels: ${labels}`;
    output += '\n\n';
  }

  return {
    ok: true,
    output,
    meta: {
      count: prs.length,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prs: prs.map((p: any) => ({ number: p.number, title: p.title })),
    },
  };
}

async function handleComment(
  params: GitHubPRParams,
  ctx: ToolContext,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const cwd = ctx.workingDir;

  if (!params.pr) {
    return { ok: false, error: '缺少 pr 参数（PR 编号或 URL）', code: 'INVALID_ARGS' };
  }
  if (!params.body) {
    return { ok: false, error: '缺少 body 参数（评论内容）', code: 'INVALID_ARGS' };
  }

  onProgress?.({ stage: 'running', detail: `评论 PR #${params.pr}...` });

  await execGh(`gh pr comment ${params.pr} --body '${escapeShellArg(params.body)}'`, cwd);

  return {
    ok: true,
    output: `已在 PR #${params.pr} 添加评论。`,
    meta: { pr: params.pr },
  };
}

async function handleReview(
  params: GitHubPRParams,
  ctx: ToolContext,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const cwd = ctx.workingDir;

  if (!params.pr) {
    return { ok: false, error: '缺少 pr 参数（PR 编号或 URL）', code: 'INVALID_ARGS' };
  }

  const event = params.event || 'comment';
  const argv: string[] = ['gh', 'pr', 'review', String(params.pr)];

  switch (event) {
    case 'approve':
      argv.push('--approve');
      break;
    case 'request-changes':
      argv.push('--request-changes');
      break;
    case 'comment':
      argv.push('--comment');
      break;
  }

  if (params.body) {
    argv.push('--body', `'${escapeShellArg(params.body)}'`);
  }

  onProgress?.({ stage: 'running', detail: `Review PR #${params.pr} (${event})...` });

  await execGh(argv.join(' '), cwd);

  return {
    ok: true,
    output: `已提交 PR #${params.pr} 的 review (${event})。`,
    meta: { pr: params.pr, event },
  };
}

async function handleMerge(
  params: GitHubPRParams,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const cwd = ctx.workingDir;

  if (!params.pr) {
    return { ok: false, error: '缺少 pr 参数（PR 编号或 URL）', code: 'INVALID_ARGS' };
  }

  // 合并 PR 是危险操作：在工具开头的通用 canUseTool 之外再触发一次二次确认。
  // reason 加 `dangerous:` 前缀，shadowAdapter.buildCanUseToolFromLegacy 会把它
  // 升级为 `dangerous_command`，走 UI 危险命令二次确认流（legacy 时代
  // context.requestPermission({type:'dangerous_command'}) 的等价实现）。
  const method = params.method || 'merge';
  const dangerousPermit = await canUseTool(
    'github_pr',
    params as unknown as Record<string, unknown>,
    `dangerous:merge PR #${params.pr} (${method})${params.delete_branch ? ' + delete branch' : ''}`,
  );
  if (!dangerousPermit.allow) {
    return {
      ok: false,
      error: `merge denied: ${dangerousPermit.reason}`,
      code: 'PERMISSION_DENIED',
    };
  }
  const argv: string[] = ['gh', 'pr', 'merge', String(params.pr)];

  switch (method) {
    case 'squash':
      argv.push('--squash');
      break;
    case 'rebase':
      argv.push('--rebase');
      break;
    default:
      argv.push('--merge');
      break;
  }

  if (params.delete_branch) {
    argv.push('--delete-branch');
  }

  onProgress?.({ stage: 'running', detail: `合并 PR #${params.pr} (${method})...` });

  const { stdout } = await execGh(argv.join(' '), cwd);

  return {
    ok: true,
    output: `PR #${params.pr} 已合并 (${method})。${params.delete_branch ? '远程分支已删除。' : ''}\n${stdout}`,
    meta: { pr: params.pr, method, deleted: params.delete_branch },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────────────────

export async function executeGithubPr(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const p = args as unknown as GitHubPRParams;

  const validActions = ['create', 'view', 'list', 'comment', 'review', 'merge'] as const;
  if (!p.action || !validActions.includes(p.action as typeof validActions[number])) {
    return {
      ok: false,
      error: `action is required and must be one of ${validActions.join('|')}`,
      code: 'INVALID_ARGS',
    };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `github_pr:${p.action}` });

  const cwd = ctx.workingDir;

  const ghError = await checkGhInstalled(cwd);
  if (ghError) {
    return { ok: false, error: ghError, code: 'INVALID_ARGS' };
  }

  try {
    let result: ToolResult<string>;
    switch (p.action) {
      case 'create':
        result = await handleCreate(p, ctx, onProgress);
        break;
      case 'view':
        result = await handleView(p, ctx, onProgress);
        break;
      case 'list':
        result = await handleList(p, ctx, onProgress);
        break;
      case 'comment':
        result = await handleComment(p, ctx, onProgress);
        break;
      case 'review':
        result = await handleReview(p, ctx, onProgress);
        break;
      case 'merge':
        result = await handleMerge(p, ctx, canUseTool, onProgress);
        break;
      default:
        return { ok: false, error: `未知操作: ${p.action}`, code: 'INVALID_ARGS' };
    }
    onProgress?.({ stage: 'completing', percent: 100 });
    return result;
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error('GitHub PR operation failed', { action: p.action, error: message });
    return { ok: false, error: `GitHub PR 操作失败: ${message}`, code: 'NETWORK_ERROR' };
  }
}

class GithubPrHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeGithubPr(args, ctx, canUseTool, onProgress);
  }
}

export const githubPrModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new GithubPrHandler();
  },
};

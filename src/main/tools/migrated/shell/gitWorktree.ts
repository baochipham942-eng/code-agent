// ============================================================================
// GitWorktree (P0-5 Migrated to ToolModule)
//
// 旧版: src/main/tools/shell/gitWorktree.ts (registered as 'git_worktree')
// 改造点：
// - 4 参数签名
// - remove 操作的 inline requestPermission → inline canUseTool
// - context.emit?.('tool_output', ...) → ctx.emit (用 'tool_output' AgentEvent)
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { NETWORK_TOOL_TIMEOUTS } from '../../../../shared/constants';

const execAsync = promisify(exec);

const schema: ToolSchema = {
  name: 'git_worktree',
  description: `Git 工作树管理工具。创建、列出、删除和清理工作树。

操作类型: list | add | remove | prune`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove', 'prune'] },
      path: { type: 'string' },
      branch: { type: 'string' },
      new_branch: { type: 'string' },
      base: { type: 'string' },
      force: { type: 'boolean' },
    },
    required: ['action'],
  },
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: false,
  allowInPlanMode: false,
};

function escapeShellArg(arg: string): string {
  return arg.replace(/'/g, "'\\''");
}

async function execGit(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, { cwd, timeout: NETWORK_TOOL_TIMEOUTS.GIT_OPERATION });
}

interface Worktree {
  path: string;
  head: string;
  branch: string;
}

async function handleList(cwd: string): Promise<ToolResult<string>> {
  const { stdout } = await execGit('git worktree list --porcelain', cwd);
  if (!stdout.trim()) return { ok: true, output: '没有工作树。' };

  const worktrees: Worktree[] = [];
  let current: Record<string, string> = {};

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) {
        worktrees.push({
          path: current.path,
          head: current.head || '',
          branch: current.branch || '(detached)',
        });
      }
      current = { path: line.substring(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.substring(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.substring(7).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.branch = '(bare)';
    } else if (line === '' && current.path) {
      worktrees.push({
        path: current.path,
        head: current.head || '',
        branch: current.branch || '(detached)',
      });
      current = {};
    }
  }
  if (current.path) {
    worktrees.push({
      path: current.path,
      head: current.head || '',
      branch: current.branch || '(detached)',
    });
  }

  let output = `工作树列表 (${worktrees.length}):\n\n`;
  for (const wt of worktrees) {
    output += `**${wt.branch}**\n`;
    output += `  路径: ${wt.path}\n`;
    output += `  HEAD: ${wt.head.substring(0, 8)}\n\n`;
  }

  return { ok: true, output, meta: { count: worktrees.length, worktrees } };
}

async function handleAdd(args: Record<string, unknown>, cwd: string): Promise<ToolResult<string>> {
  const newBranch = args.new_branch as string | undefined;
  const branch = args.branch as string | undefined;
  const base = args.base as string | undefined;
  let worktreePath = args.path as string | undefined;

  if (!worktreePath) {
    const branchName = newBranch || branch || 'worktree';
    const safeName = branchName.replace(/[/\\]/g, '-');
    const repoName = path.basename(cwd);
    worktreePath = path.join(path.dirname(cwd), `${repoName}-${safeName}`);
  }

  const cmd: string[] = ['git', 'worktree', 'add'];

  if (newBranch) {
    cmd.push('-b', `'${escapeShellArg(newBranch)}'`);
    cmd.push(`'${escapeShellArg(worktreePath)}'`);
    if (base) cmd.push(`'${escapeShellArg(base)}'`);
  } else if (branch) {
    cmd.push(`'${escapeShellArg(worktreePath)}'`, `'${escapeShellArg(branch)}'`);
  } else {
    return {
      ok: false,
      error: '请指定 branch（检出已有分支）或 new_branch（创建新分支）。',
      code: 'INVALID_ARGS',
    };
  }

  const { stdout, stderr } = await execGit(cmd.join(' '), cwd);
  const output = (stdout + '\n' + stderr).trim();

  return {
    ok: true,
    output: `工作树创建成功:\n路径: ${worktreePath}\n分支: ${newBranch || branch}\n\n${output}`,
    meta: { path: worktreePath, branch: newBranch || branch },
  };
}

async function handleRemove(
  args: Record<string, unknown>,
  cwd: string,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const targetPath = args.path as string | undefined;
  const force = Boolean(args.force);

  if (!targetPath) {
    return { ok: false, error: '缺少 path 参数（工作树路径）', code: 'INVALID_ARGS' };
  }

  // 删除工作树是破坏性操作，inline 二次问权限
  const permit = await canUseTool(
    'git_worktree',
    { action: 'remove', path: targetPath, force },
    `删除工作树: ${targetPath}`,
  );
  if (!permit.allow) {
    return { ok: false, error: `用户取消了删除操作: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }

  const cmd: string[] = ['git', 'worktree', 'remove'];
  if (force) cmd.push('--force');
  cmd.push(`'${escapeShellArg(targetPath)}'`);

  await execGit(cmd.join(' '), cwd);

  return {
    ok: true,
    output: `工作树已删除: ${targetPath}`,
    meta: { path: targetPath },
  };
}

async function handlePrune(cwd: string): Promise<ToolResult<string>> {
  const { stdout: dryRun } = await execGit('git worktree prune --dry-run', cwd);

  if (!dryRun.trim()) {
    return { ok: true, output: '没有需要清理的工作树引用。' };
  }

  await execGit('git worktree prune', cwd);

  return { ok: true, output: `已清理过期的工作树引用:\n${dryRun.trim()}` };
}

class GitWorktreeHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const action = args.action as string | undefined;

    if (!action) {
      return { ok: false, error: 'action is required', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `git_worktree ${action}` });

    try {
      let result: ToolResult<string>;
      switch (action) {
        case 'list':
          result = await handleList(ctx.workingDir);
          break;
        case 'add':
          result = await handleAdd(args, ctx.workingDir);
          break;
        case 'remove':
          result = await handleRemove(args, ctx.workingDir, canUseTool);
          break;
        case 'prune':
          result = await handlePrune(ctx.workingDir);
          break;
        default:
          return { ok: false, error: `未知操作: ${action}`, code: 'INVALID_ACTION' };
      }
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('git_worktree done', { action });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn('git_worktree failed', { action, err: msg });
      return { ok: false, error: `Git worktree 操作失败: ${msg}`, code: 'GIT_FAILED' };
    }
  }
}

export const gitWorktreeModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new GitWorktreeHandler();
  },
};

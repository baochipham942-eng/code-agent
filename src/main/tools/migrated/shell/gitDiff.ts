// ============================================================================
// GitDiff (P0-5 Migrated to ToolModule)
//
// 旧版: src/main/tools/shell/gitDiff.ts (registered as 'git_diff')
// 改造点：4 参数签名 + ctx.logger + ctx.workingDir + canUseTool
// 业务依赖：child_process exec, NETWORK_TOOL_TIMEOUTS（共享 constants）
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
import { NETWORK_TOOL_TIMEOUTS } from '../../../../shared/constants';

const execAsync = promisify(exec);

const schema: ToolSchema = {
  name: 'git_diff',
  description: `Git 差异分析工具。查看未暂存/已暂存/跨分支差异和特定提交内容。

操作类型: diff (未暂存) | diff_staged (已暂存) | diff_branch (跨分支) | show (特定提交)`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['diff', 'diff_staged', 'diff_branch', 'show'] },
      files: { type: 'array', items: { type: 'string' } },
      stat_only: { type: 'boolean' },
      base: { type: 'string' },
      head: { type: 'string' },
      commit: { type: 'string' },
    },
    required: ['action'],
  },
  category: 'shell',
  permissionLevel: 'execute',
  readOnly: true, // diff 是只读操作
  allowInPlanMode: true,
};

const MAX_DIFF_LENGTH = 50_000;

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_LENGTH) return diff;
  return (
    diff.substring(0, MAX_DIFF_LENGTH) +
    `\n\n[差异内容过长，已截断。原始 ${diff.length} 字符，显示前 ${MAX_DIFF_LENGTH} 字符。]`
  );
}

async function execGit(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, {
    cwd,
    timeout: NETWORK_TOOL_TIMEOUTS.GIT_OPERATION,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function handleDiff(args: Record<string, unknown>, cwd: string): Promise<ToolResult<string>> {
  const stat_only = Boolean(args.stat_only);
  const files = args.files as string[] | undefined;

  const cmd: string[] = ['git', 'diff'];
  if (stat_only) cmd.push('--stat');
  if (files && files.length > 0) cmd.push('--', ...files);

  const { stdout } = await execGit(cmd.join(' '), cwd);
  if (!stdout.trim()) return { ok: true, output: '没有未暂存的更改。' };
  return { ok: true, output: truncateDiff(stdout), meta: { type: 'unstaged' } };
}

async function handleDiffStaged(args: Record<string, unknown>, cwd: string): Promise<ToolResult<string>> {
  const stat_only = Boolean(args.stat_only);
  const files = args.files as string[] | undefined;

  const cmd: string[] = ['git', 'diff', '--cached'];
  if (stat_only) cmd.push('--stat');
  if (files && files.length > 0) cmd.push('--', ...files);

  const { stdout } = await execGit(cmd.join(' '), cwd);
  if (!stdout.trim()) return { ok: true, output: '没有已暂存的更改。' };
  return { ok: true, output: truncateDiff(stdout), meta: { type: 'staged' } };
}

async function handleDiffBranch(args: Record<string, unknown>, cwd: string): Promise<ToolResult<string>> {
  const base = (args.base as string | undefined) ?? 'main';
  const head = (args.head as string | undefined) ?? 'HEAD';
  const stat_only = Boolean(args.stat_only);
  const files = args.files as string[] | undefined;

  const cmd: string[] = ['git', 'diff'];
  if (stat_only) cmd.push('--stat');
  cmd.push(`${base}...${head}`);
  if (files && files.length > 0) cmd.push('--', ...files);

  const { stdout } = await execGit(cmd.join(' '), cwd);
  if (!stdout.trim()) return { ok: true, output: `${base} 和 ${head} 之间没有差异。` };
  return { ok: true, output: truncateDiff(stdout), meta: { type: 'branch', base, head } };
}

async function handleShow(args: Record<string, unknown>, cwd: string): Promise<ToolResult<string>> {
  const commit = (args.commit as string | undefined) ?? 'HEAD';
  const stat_only = Boolean(args.stat_only);

  const cmd: string[] = ['git', 'show'];
  if (stat_only) cmd.push('--stat');
  cmd.push(commit);

  const { stdout } = await execGit(cmd.join(' '), cwd);
  return { ok: true, output: truncateDiff(stdout), meta: { type: 'show', commit } };
}

class GitDiffHandler implements ToolHandler<Record<string, unknown>, string> {
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

    onProgress?.({ stage: 'starting', detail: `git_diff ${action}` });

    try {
      let result: ToolResult<string>;
      switch (action) {
        case 'diff':
          result = await handleDiff(args, ctx.workingDir);
          break;
        case 'diff_staged':
          result = await handleDiffStaged(args, ctx.workingDir);
          break;
        case 'diff_branch':
          result = await handleDiffBranch(args, ctx.workingDir);
          break;
        case 'show':
          result = await handleShow(args, ctx.workingDir);
          break;
        default:
          return { ok: false, error: `未知操作: ${action}`, code: 'INVALID_ACTION' };
      }
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('git_diff done', { action });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn('git_diff failed', { action, err: msg });
      return { ok: false, error: `Git diff 操作失败: ${msg}`, code: 'GIT_FAILED' };
    }
  }
}

export const gitDiffModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new GitDiffHandler();
  },
};

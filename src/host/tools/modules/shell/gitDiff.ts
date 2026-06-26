// ============================================================================
// GitDiff (P0-5 Migrated to ToolModule)
//
// 旧版: src/host/tools/shell/gitDiff.ts (registered as 'git_diff')
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
} from '../../../protocol/tools';
import { gitDiffSchema as schema } from './gitDiff.schema';
import { NETWORK_TOOL_TIMEOUTS } from '../../../../shared/constants';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';

const execAsync = promisify(exec);

const MAX_DIFF_LENGTH = 50_000;

interface DiffSummary {
  files: string[];
  fileCount: number;
  additions?: number;
  deletions?: number;
  hunks?: number;
  truncated: boolean;
}

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

function summarizeDiff(diff: string, truncated: boolean): DiffSummary {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let hunks = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (match) files.add(match[2]);
    } else if (line.startsWith('+++ b/')) {
      files.add(line.slice(6));
    } else if (line.startsWith('@@')) {
      hunks++;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  return { files: [...files], fileCount: files.size, additions, deletions, hunks, truncated };
}

function summarizeStat(stat: string, truncated: boolean): DiffSummary {
  const files = new Set<string>();
  const summary: DiffSummary = { files: [], fileCount: 0, truncated };
  for (const line of stat.split('\n')) {
    const match = /^\s*(.+?)\s+\|\s+\d+/.exec(line);
    if (match) files.add(match[1].trim());
    const totals = /(\d+) insertions?\(\+\)/.exec(line);
    if (totals) summary.additions = Number(totals[1]);
    const deletions = /(\d+) deletions?\(-\)/.exec(line);
    if (deletions) summary.deletions = Number(deletions[1]);
  }
  summary.files = [...files];
  summary.fileCount = files.size;
  return summary;
}

function buildDiffResult(
  args: Record<string, unknown>,
  ctx: ToolContext,
  output: string,
  meta: Record<string, unknown>,
): ToolResult<string> {
  const truncated = output.length > MAX_DIFF_LENGTH;
  const displayOutput = truncateDiff(output);
  const statOnly = Boolean(args.stat_only);
  const diffSummary = statOnly
    ? summarizeStat(output, truncated)
    : summarizeDiff(output, truncated);
  const artifact = createVirtualArtifact({
    sourceTool: schema.name,
    kind: statOnly ? 'process-output' : 'text',
    sessionId: ctx.sessionId,
    name: `${schema.name}:${String(meta.type ?? meta.action ?? 'diff')}`,
    mimeType: statOnly ? 'text/plain' : 'text/x-diff',
    contentLength: output.length,
    preview: displayOutput.slice(0, 1000),
    metadata: {
      action: meta.action ?? args.action,
      ...meta,
      diffSummary,
    },
  });

  return {
    ok: true,
    output: displayOutput,
    meta: {
      action: args.action,
      ...meta,
      statOnly,
      changedFiles: diffSummary.files,
      diffSummary,
      artifact,
    },
  };
}

function buildEmptyDiffResult(
  ctx: ToolContext,
  action: string,
  output: string,
  meta: Record<string, unknown>,
): ToolResult<string> {
  const diffSummary: DiffSummary = { files: [], fileCount: 0, additions: 0, deletions: 0, hunks: 0, truncated: false };
  return {
    ok: true,
    output,
    meta: {
      action,
      ...meta,
      statOnly: false,
      changedFiles: [],
      diffSummary,
      artifact: createVirtualArtifact({
        sourceTool: schema.name,
        kind: 'process-output',
        sessionId: ctx.sessionId,
        name: `${schema.name}:${String(meta.type ?? action)}:empty`,
        mimeType: 'text/plain',
        contentLength: output.length,
        preview: output,
        metadata: {
          action,
          ...meta,
          diffSummary,
        },
      }),
    },
  };
}

async function handleDiff(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<string>> {
  const stat_only = Boolean(args.stat_only);
  const files = args.files as string[] | undefined;

  const cmd: string[] = ['git', 'diff'];
  if (stat_only) cmd.push('--stat');
  if (files && files.length > 0) cmd.push('--', ...files);

  const { stdout } = await execGit(cmd.join(' '), ctx.workingDir);
  if (!stdout.trim()) return buildEmptyDiffResult(ctx, 'diff', '没有未暂存的更改。', { type: 'unstaged' });
  return buildDiffResult(args, ctx, stdout, { type: 'unstaged' });
}

async function handleDiffStaged(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<string>> {
  const stat_only = Boolean(args.stat_only);
  const files = args.files as string[] | undefined;

  const cmd: string[] = ['git', 'diff', '--cached'];
  if (stat_only) cmd.push('--stat');
  if (files && files.length > 0) cmd.push('--', ...files);

  const { stdout } = await execGit(cmd.join(' '), ctx.workingDir);
  if (!stdout.trim()) return buildEmptyDiffResult(ctx, 'diff_staged', '没有已暂存的更改。', { type: 'staged' });
  return buildDiffResult(args, ctx, stdout, { type: 'staged' });
}

async function handleDiffBranch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<string>> {
  const base = (args.base as string | undefined) ?? 'main';
  const head = (args.head as string | undefined) ?? 'HEAD';
  const stat_only = Boolean(args.stat_only);
  const files = args.files as string[] | undefined;

  const cmd: string[] = ['git', 'diff'];
  if (stat_only) cmd.push('--stat');
  cmd.push(`${base}...${head}`);
  if (files && files.length > 0) cmd.push('--', ...files);

  const { stdout } = await execGit(cmd.join(' '), ctx.workingDir);
  if (!stdout.trim()) {
    return buildEmptyDiffResult(ctx, 'diff_branch', `${base} 和 ${head} 之间没有差异。`, { type: 'branch', base, head });
  }
  return buildDiffResult(args, ctx, stdout, { type: 'branch', base, head });
}

async function handleShow(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult<string>> {
  const commit = (args.commit as string | undefined) ?? 'HEAD';
  const stat_only = Boolean(args.stat_only);

  const cmd: string[] = ['git', 'show'];
  if (stat_only) cmd.push('--stat');
  cmd.push(commit);

  const [{ stdout }, hashResult] = await Promise.all([
    execGit(cmd.join(' '), ctx.workingDir),
    execGit(`git rev-parse ${commit}`, ctx.workingDir).catch(() => ({ stdout: '', stderr: '' })),
  ]);
  return buildDiffResult(args, ctx, stdout, {
    type: 'show',
    commit,
    commitHash: hashResult.stdout.trim() || undefined,
  });
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
          result = await handleDiff(args, ctx);
          break;
        case 'diff_staged':
          result = await handleDiffStaged(args, ctx);
          break;
        case 'diff_branch':
          result = await handleDiffBranch(args, ctx);
          break;
        case 'show':
          result = await handleShow(args, ctx);
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

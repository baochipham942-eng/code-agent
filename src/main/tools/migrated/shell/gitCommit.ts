// ============================================================================
// GitCommit (P0-5 Migrated to ToolModule)
//
// 旧版: src/main/tools/shell/gitCommit.ts (registered as 'git_commit')
// 改造点：
// - 4 参数签名
// - push 操作的 inline requestPermission → inline canUseTool 调用
// - context.workingDirectory → ctx.workingDir
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
  name: 'git_commit',
  description: `Git 提交管理工具。查看状态、暂存文件、提交、推送和查看日志。

操作类型: status | add | commit | push | log`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'add', 'commit', 'push', 'log'] },
      files: { type: 'array', items: { type: 'string' } },
      all: { type: 'boolean' },
      message: { type: 'string' },
      amend: { type: 'boolean' },
      remote: { type: 'string' },
      branch: { type: 'string' },
      set_upstream: { type: 'boolean' },
      limit: { type: 'number' },
      oneline: { type: 'boolean' },
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

async function handleStatus(cwd: string): Promise<ToolResult<string>> {
  const [statusResult, branchResult] = await Promise.all([
    execGit('git status --porcelain', cwd),
    execGit('git branch --show-current', cwd).catch(() => ({ stdout: '', stderr: '' })),
  ]);

  const branch = branchResult.stdout.trim() || '(detached)';
  // 注意：legacy 这里是 stdout.trim().split('\n')，会吃掉第一行的 leading space
  // 导致 " M file" 变成 "M file"，substring(3) 错位 — pre-existing bug，V2 修了
  const lines = statusResult.stdout.split('\n').filter((l) => l.length > 0);

  if (lines.length === 0) {
    return {
      ok: true,
      output: `分支: ${branch}\n工作区干净，没有未提交的更改。`,
      meta: { branch, clean: true, staged: 0, unstaged: 0, untracked: 0 },
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
    output += `**已暂存** (${staged}):\n${stagedFiles.map((f) => `  ${f}`).join('\n')}\n\n`;
  }
  if (unstagedFiles.length > 0) {
    output += `**未暂存** (${unstaged}):\n${unstagedFiles.map((f) => `  ${f}`).join('\n')}\n\n`;
  }
  if (untrackedFiles.length > 0) {
    output += `**未跟踪** (${untracked}):\n${untrackedFiles.map((f) => `  ${f}`).join('\n')}\n`;
  }

  return { ok: true, output, meta: { branch, clean: false, staged, unstaged, untracked } };
}

async function handleAdd(args: Record<string, unknown>, cwd: string): Promise<ToolResult<string>> {
  const all = Boolean(args.all);
  const files = args.files as string[] | undefined;

  if (all) {
    await execGit('git add -A', cwd);
    return { ok: true, output: '已暂存所有更改。' };
  }

  if (!files || files.length === 0) {
    return { ok: false, error: '请指定要暂存的文件，或使用 all: true 暂存全部。', code: 'INVALID_ARGS' };
  }

  // 安全检查：敏感文件警告
  const sensitivePatterns = ['.env', 'credentials', '.pem', '_secret', '.key'];
  const sensitiveFiles = files.filter((f) =>
    sensitivePatterns.some((p) => f.toLowerCase().includes(p)),
  );
  if (sensitiveFiles.length > 0) {
    return {
      ok: false,
      error: `⚠️ 检测到可能包含密钥的文件: ${sensitiveFiles.join(', ')}。确认需要提交请使用 Bash 工具手动执行 git add。`,
      code: 'SENSITIVE_FILE',
    };
  }

  const fileArgs = files.map((f) => `'${escapeShellArg(f)}'`).join(' ');
  await execGit(`git add ${fileArgs}`, cwd);

  return {
    ok: true,
    output: `已暂存 ${files.length} 个文件:\n${files.map((f) => `  + ${f}`).join('\n')}`,
    meta: { files },
  };
}

async function handleCommit(args: Record<string, unknown>, cwd: string): Promise<ToolResult<string>> {
  const message = args.message as string | undefined;
  const amend = Boolean(args.amend);

  if (!message) {
    return { ok: false, error: '缺少 message 参数（提交信息）', code: 'INVALID_ARGS' };
  }

  // amend 安全检查：上一次提交已推送则拒绝
  if (amend) {
    try {
      const { stdout } = await execGit('git status', cwd);
      if (stdout.includes('up to date')) {
        return {
          ok: false,
          error: '上一次提交已推送到远程，amend 会导致历史不一致。请创建新提交。',
          code: 'AMEND_PUSHED',
        };
      }
    } catch {
      // 无法判断，保守处理（继续）
    }
  }

  const cmd: string[] = ['git', 'commit'];
  if (amend) cmd.push('--amend');
  cmd.push('-m', `'${escapeShellArg(message)}'`);

  const { stdout } = await execGit(cmd.join(' '), cwd);

  return { ok: true, output: `提交成功:\n${stdout.trim()}`, meta: { amend } };
}

async function handlePush(
  args: Record<string, unknown>,
  cwd: string,
  canUseTool: CanUseToolFn,
): Promise<ToolResult<string>> {
  const remote = (args.remote as string | undefined) ?? 'origin';
  const branch = args.branch as string | undefined;
  const set_upstream = Boolean(args.set_upstream);

  // Push 是远程操作，inline 二次问权限（带具体上下文）
  const permit = await canUseTool('git_commit', { action: 'push', remote, branch }, '推送代码到远程仓库');
  if (!permit.allow) {
    return { ok: false, error: `用户取消了推送操作: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }

  const cmd: string[] = ['git', 'push'];
  if (set_upstream) cmd.push('-u');
  cmd.push(remote);
  if (branch) cmd.push(branch);

  const { stdout, stderr } = await execGit(cmd.join(' '), cwd);
  const output = (stdout + '\n' + stderr).trim();

  return { ok: true, output: `推送成功:\n${output}` };
}

async function handleLog(args: Record<string, unknown>, cwd: string): Promise<ToolResult<string>> {
  const limit = (args.limit as number | undefined) ?? 10;
  const oneline = Boolean(args.oneline);

  const format = oneline
    ? `git log --oneline --no-decorate -${limit}`
    : `git log --format='%h %s (%an, %ar)' -${limit}`;

  const { stdout } = await execGit(format, cwd);

  return { ok: true, output: stdout.trim() || '没有提交记录。', meta: { limit } };
}

class GitCommitHandler implements ToolHandler<Record<string, unknown>, string> {
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

    onProgress?.({ stage: 'starting', detail: `git_commit ${action}` });

    try {
      let result: ToolResult<string>;
      switch (action) {
        case 'status':
          result = await handleStatus(ctx.workingDir);
          break;
        case 'add':
          result = await handleAdd(args, ctx.workingDir);
          break;
        case 'commit':
          result = await handleCommit(args, ctx.workingDir);
          break;
        case 'push':
          result = await handlePush(args, ctx.workingDir, canUseTool);
          break;
        case 'log':
          result = await handleLog(args, ctx.workingDir);
          break;
        default:
          return { ok: false, error: `未知操作: ${action}`, code: 'INVALID_ACTION' };
      }
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('git_commit done', { action });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn('git_commit failed', { action, err: msg });
      return { ok: false, error: `Git 操作失败: ${msg}`, code: 'GIT_FAILED' };
    }
  }
}

export const gitCommitModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new GitCommitHandler();
  },
};

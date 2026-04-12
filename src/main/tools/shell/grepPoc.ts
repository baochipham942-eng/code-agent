// ============================================================================
// Grep (P0-5 POC version)
//
// 最小实现：直接 spawn 系统 grep -rn，不依赖 ripgrep
// 选择系统 grep 而非 rg：macOS/Linux 都自带，POC 不需要追求 rg 的性能
// 复杂的 type filter / EAGAIN retry / glob 排除 等留给生产版迁移
// ============================================================================

import { spawn } from 'child_process';
import path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../protocol/tools';

const schema: ToolSchema = {
  name: 'GrepPoc',
  description: '按正则在文件中搜索（P0-5 POC 版本，走系统 grep -rn）',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索根目录或文件，默认 workingDir' },
      case_insensitive: { type: 'boolean' },
      head_limit: { type: 'number', description: '最多返回匹配行数' },
    },
    required: ['pattern'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

interface GrepOutput {
  matches: string[];
  count: number;
  truncated: boolean;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_HEAD_LIMIT = 250;

class GrepPocHandler implements ToolHandler<Record<string, unknown>, GrepOutput> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<GrepOutput>> {
    const pattern = args.pattern as string | undefined;
    const searchPath = (args.path as string | undefined) ?? ctx.workingDir;
    const caseInsensitive = Boolean(args.case_insensitive);
    const headLimit = (args.head_limit as number | undefined) ?? DEFAULT_HEAD_LIMIT;

    if (!pattern || typeof pattern !== 'string') {
      return { ok: false, error: 'pattern 必须是字符串', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }

    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const absRoot = path.isAbsolute(searchPath)
      ? searchPath
      : path.resolve(ctx.workingDir, searchPath);

    const grepArgs = ['-r', '-n', '-E'];
    if (caseInsensitive) grepArgs.push('-i');
    grepArgs.push(
      '--exclude-dir=node_modules',
      '--exclude-dir=.git',
      '--exclude-dir=dist',
      '--exclude-dir=build',
    );
    grepArgs.push('--', pattern, absRoot);

    onProgress?.({ stage: 'starting', detail: `grep ${pattern.slice(0, 40)}` });

    return new Promise<ToolResult<GrepOutput>>((resolve) => {
      const child = spawn('grep', grepArgs, { cwd: ctx.workingDir });
      let stdout = '';
      let outBytes = 0;
      let killed = false;

      const killWith = (reason: string, code: string) => {
        if (killed) return;
        killed = true;
        child.kill('SIGTERM');
        resolve({ ok: false, error: reason, code });
      };

      const onAbort = () => killWith('aborted by ctx.abortSignal', 'ABORTED');
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > MAX_OUTPUT_BYTES) {
          killWith('output exceeded 2MB', 'OUTPUT_TOO_LARGE');
          return;
        }
        stdout += chunk.toString('utf-8');
      });

      child.stderr?.on('data', () => {
        // grep 的 stderr 多是 "Permission denied" 之类，忽略
      });

      child.on('close', (exitCode) => {
        ctx.abortSignal.removeEventListener('abort', onAbort);
        if (killed) return;

        // grep exit code: 0 = match, 1 = no match, >1 = error
        if (exitCode !== null && exitCode > 1) {
          resolve({ ok: false, error: `grep exited ${exitCode}`, code: 'GREP_ERROR' });
          return;
        }

        const lines = stdout.split('\n').filter((l) => l.length > 0);
        const truncated = lines.length > headLimit;
        const matches = truncated ? lines.slice(0, headLimit) : lines;

        onProgress?.({ stage: 'completing', percent: 100 });
        ctx.logger.info('GrepPoc done', {
          pattern,
          matches: matches.length,
          total: lines.length,
          truncated,
        });

        resolve({
          ok: true,
          output: { matches, count: matches.length, truncated },
        });
      });

      child.on('error', (err) => {
        ctx.abortSignal.removeEventListener('abort', onAbort);
        if (killed) return;
        killed = true;
        resolve({ ok: false, error: err.message, code: 'SPAWN_ERROR' });
      });
    });
  }
}

export const grepPocModule: ToolModule<Record<string, unknown>, GrepOutput> = {
  schema,
  createHandler() {
    return new GrepPocHandler();
  },
};

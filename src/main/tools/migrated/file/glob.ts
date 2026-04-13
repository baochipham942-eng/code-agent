// ============================================================================
// Glob (P0-6.3 Batch 1 — file-core: native ToolModule rewrite)
//
// 旧版: src/main/tools/file/glob.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger
// - 行为保真：
//   * 使用 glob 库 (nodir: true)
//   * 固定 ignore 列表：node_modules / .git / dist / build / .next / coverage
//   * 结果截断到 200 条，超出部分追加 "... (N more files)"
//   * path 可选，默认 ctx.workingDir，支持 ~ 和相对路径
//   * 空结果返回 "No files matched the pattern"
// ============================================================================

import { glob as globLib } from 'glob';
import * as os from 'os';
import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { globSchema as schema } from './glob.schema';

const MAX_RESULTS = 200;
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
];

function expandTilde(filePath: string): string {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function resolveInputPath(inputPath: string, workingDir: string): string {
  const expanded = expandTilde(inputPath);
  if (path.isAbsolute(expanded)) return expanded;
  return path.join(workingDir, expanded);
}

class GlobHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const pattern = args.pattern;
    if (typeof pattern !== 'string' || !pattern) {
      return {
        ok: false,
        error: 'pattern is required and must be a string',
        code: 'INVALID_ARGS',
      };
    }

    const inputPath = (args.path as string | undefined) || ctx.workingDir;

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return {
        ok: false,
        error: `permission denied: ${permit.reason}`,
        code: 'PERMISSION_DENIED',
      };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const searchPath = resolveInputPath(inputPath, ctx.workingDir);

    onProgress?.({ stage: 'starting', detail: `glob ${pattern}` });

    try {
      const matches = await globLib(pattern, {
        cwd: searchPath,
        nodir: true,
        ignore: DEFAULT_IGNORE,
      });

      if (matches.length === 0) {
        onProgress?.({ stage: 'completing', percent: 100 });
        return { ok: true, output: 'No files matched the pattern' };
      }

      const sliced = matches.slice(0, MAX_RESULTS);
      let result = sliced.join('\n');
      if (matches.length > MAX_RESULTS) {
        result += `\n\n... (${matches.length - MAX_RESULTS} more files)`;
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug('Glob done', {
        pattern,
        searchPath,
        total: matches.length,
        returned: sliced.length,
      });
      return { ok: true, output: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: message || 'Failed to search files',
        code: 'FS_ERROR',
      };
    }
  }
}

export const globModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new GlobHandler();
  },
};

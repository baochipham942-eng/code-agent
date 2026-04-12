// ============================================================================
// Glob (P0-5 POC version)
//
// 最小实现：用 `glob` npm 库做 pattern match，readOnly 无副作用
// 对比旧版 src/main/tools/file/glob.ts：
//   - 不 import services/infra/logger → 用 ctx.logger
//   - 同样的默认排除规则（node_modules/.git/dist/build/.next/coverage）
//   - 200 文件截断阈值保持一致
// ============================================================================

import { glob as globLib } from 'glob';
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
  name: 'GlobPoc',
  description: '按 glob pattern 查找文件（P0-5 POC 版本）',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，例如 **/*.ts' },
      path: { type: 'string', description: '搜索根目录，默认 workingDir' },
    },
    required: ['pattern'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

interface GlobOutput {
  files: string[];
  count: number;
  truncated: boolean;
}

const MAX_RESULTS = 200;
const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
];

class GlobPocHandler implements ToolHandler<Record<string, unknown>, GlobOutput> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<GlobOutput>> {
    const pattern = args.pattern as string | undefined;
    const searchPath = (args.path as string | undefined) ?? ctx.workingDir;

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

    onProgress?.({ stage: 'starting', detail: `glob ${pattern}` });

    const absRoot = path.isAbsolute(searchPath)
      ? searchPath
      : path.resolve(ctx.workingDir, searchPath);

    try {
      const matches = await globLib(pattern, {
        cwd: absRoot,
        ignore: DEFAULT_IGNORES,
        nodir: true,
        absolute: true,
      });

      const truncated = matches.length > MAX_RESULTS;
      const files = truncated ? matches.slice(0, MAX_RESULTS) : matches;

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('GlobPoc done', {
        pattern,
        root: absRoot,
        count: files.length,
        total: matches.length,
        truncated,
      });

      return {
        ok: true,
        output: { files, count: files.length, truncated },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn('GlobPoc failed', { pattern, root: absRoot, err: msg });
      return { ok: false, error: msg, code: 'GLOB_ERROR' };
    }
  }
}

export const globPocModule: ToolModule<Record<string, unknown>, GlobOutput> = {
  schema,
  createHandler() {
    return new GlobPocHandler();
  },
};

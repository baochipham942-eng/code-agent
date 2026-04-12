// ============================================================================
// Read (P0-5 POC version)
//
// 目的：验证 ToolModule 4 参数签名 + ctx.logger 注入 + 零 services import
//
// 对比旧版 src/main/tools/file/read.ts：
//   - 不 import '../../services/infra/logger' → 用 ctx.logger
//   - 不引 resolvePath 等业务 helper → POC 只做最小 fs 读取
//   - 参数验证、路径兼容都简化，生产版迁移时再补齐
// ============================================================================

import { promises as fs } from 'fs';
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
  name: 'ReadPoc',
  description: '读取文件内容（P0-5 POC 版本，走 ToolModule 接口）',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '绝对路径' },
      offset: { type: 'number', description: '起始行号 (1-indexed)' },
      limit: { type: 'number', description: '读取行数上限' },
    },
    required: ['file_path'],
  },
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

interface ReadOutput {
  content: string;
  lineCount: number;
  truncated: boolean;
  fromCache: boolean;
}

class ReadPocHandler implements ToolHandler<Record<string, unknown>, ReadOutput> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<ReadOutput>> {
    const file_path = args.file_path as string | undefined;
    const offset = (args.offset as number | undefined) ?? 1;
    const limit = (args.limit as number | undefined) ?? 2000;

    if (!file_path || typeof file_path !== 'string') {
      return { ok: false, error: 'file_path 必须是字符串', code: 'INVALID_ARGS' };
    }

    // 权限闸门（read 也要过 — 可能命中 deny 规则）
    const permit = await canUseTool(schema.name, args as unknown as Record<string, unknown>);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }

    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `reading ${path.basename(file_path)}` });

    // 路径归一化（绝对路径 or 相对 workingDir）
    const absPath = path.isAbsolute(file_path)
      ? file_path
      : path.resolve(ctx.workingDir, file_path);

    try {
      const stat = await fs.stat(absPath);

      // 命中缓存
      const cached = ctx.fileCache?.get(absPath);
      let rawContent: string;
      let fromCache = false;
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        rawContent = cached.content;
        fromCache = true;
        ctx.logger.debug('ReadPoc cache hit', { absPath });
      } else {
        onProgress?.({ stage: 'running', percent: 50 });
        rawContent = await fs.readFile(absPath, 'utf-8');
        ctx.fileCache?.set(absPath, rawContent, stat.mtimeMs);
      }

      const allLines = rawContent.split('\n');
      const startIdx = Math.max(0, offset - 1);
      const endIdx = Math.min(allLines.length, startIdx + limit);
      const sliceLines = allLines.slice(startIdx, endIdx);
      const truncated = endIdx < allLines.length;

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('ReadPoc done', {
        absPath,
        lines: sliceLines.length,
        total: allLines.length,
        fromCache,
      });

      return {
        ok: true,
        output: {
          content: sliceLines.join('\n'),
          lineCount: sliceLines.length,
          truncated,
          fromCache,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn('ReadPoc failed', { absPath, err: msg });
      return { ok: false, error: msg, code: 'FS_ERROR' };
    }
  }
}

export const readPocModule: ToolModule<Record<string, unknown>, ReadOutput> = {
  schema,
  createHandler() {
    return new ReadPocHandler();
  },
};

// ============================================================================
// Write (P0-5 POC version) — DRY RUN ONLY
//
// 副作用类工具不能盲跑 shadow（会重复写文件破坏 user state），所以 POC 走纯 dry-run：
// - 验证参数 + 路径 + 权限闸门
// - stat 文件判断 would-create vs would-update
// - 计算 byte 长度，但 **绝不调用 fs.writeFile**
// - 返回 metadata 让 LLM 知道改动尺度
//
// 这种 dry-run 模式天然适合 plan-mode："如果改了会怎样"。
// 生产 Write 仍走 legacy 路径直到全量迁移；POC 只验证 4 参数签名能表达写操作语义。
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
  name: 'WritePoc',
  description: '写入文件（P0-5 POC dry-run 版本，不实际写盘，只返回 metadata）',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '绝对路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['file_path', 'content'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false, // 语义上是 write，即使 dry-run
  allowInPlanMode: true, // dry-run 在 plan-mode 下安全
};

interface WriteDryRunOutput {
  wouldCreate: boolean;
  wouldUpdate: boolean;
  absPath: string;
  bytes: number;
  lineCount: number;
  existingBytes?: number;
  existingLineCount?: number;
  dryRun: true;
}

class WritePocHandler implements ToolHandler<Record<string, unknown>, WriteDryRunOutput> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<WriteDryRunOutput>> {
    const file_path = args.file_path as string | undefined;
    const content = args.content as string | undefined;

    if (!file_path || typeof file_path !== 'string') {
      return { ok: false, error: 'file_path 必须是字符串', code: 'INVALID_ARGS' };
    }
    if (typeof content !== 'string') {
      return { ok: false, error: 'content 必须是字符串', code: 'INVALID_ARGS' };
    }

    // 权限闸门 — write 类工具必须真问
    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }

    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `dry-run write ${path.basename(file_path)}` });

    const absPath = path.isAbsolute(file_path)
      ? file_path
      : path.resolve(ctx.workingDir, file_path);

    const bytes = Buffer.byteLength(content, 'utf-8');
    const lineCount = content.split('\n').length;

    let wouldCreate = true;
    let wouldUpdate = false;
    let existingBytes: number | undefined;
    let existingLineCount: number | undefined;

    try {
      const stat = await fs.stat(absPath);
      // 文件存在 → would update
      wouldCreate = false;
      wouldUpdate = true;
      existingBytes = stat.size;
      // 算原文件行数（用 fileCache 优先）
      const cached = ctx.fileCache?.get(absPath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        existingLineCount = cached.content.split('\n').length;
      } else {
        try {
          const raw = await fs.readFile(absPath, 'utf-8');
          existingLineCount = raw.split('\n').length;
          ctx.fileCache?.set(absPath, raw, stat.mtimeMs);
        } catch {
          // 读失败不致命，dry-run 仍可完成
        }
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') {
        // ENOENT 是新建场景，预期；其他错才返错
        return { ok: false, error: e.message, code: 'STAT_ERROR' };
      }
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('WritePoc dry-run done', {
      absPath,
      wouldCreate,
      wouldUpdate,
      bytes,
      existingBytes,
    });

    return {
      ok: true,
      output: {
        wouldCreate,
        wouldUpdate,
        absPath,
        bytes,
        lineCount,
        existingBytes,
        existingLineCount,
        dryRun: true,
      },
    };
  }
}

export const writePocModule: ToolModule<Record<string, unknown>, WriteDryRunOutput> = {
  schema,
  createHandler() {
    return new WritePocHandler();
  },
};

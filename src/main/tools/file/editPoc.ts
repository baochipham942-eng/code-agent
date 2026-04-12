// ============================================================================
// Edit (P0-5 POC version) — DRY RUN ONLY
//
// 同 writePoc 的逻辑：读文件 + 计算 would-replace 次数，**不调用 fs.writeFile**
// 旧 Edit 的 fileReadTracker / curly quote 标准化 / LSP 诊断这些复杂功能
// POC 阶段都不做，只验证 4 参数签名能描述 "替换 N 次" 这种 mutation 意图。
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
  name: 'EditPoc',
  description: '编辑文件（P0-5 POC dry-run 版本，只算替换次数不写回）',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '绝对路径' },
      old_text: { type: 'string', description: '待替换文本' },
      new_text: { type: 'string', description: '替换后文本' },
      replace_all: { type: 'boolean', description: '是否全文替换' },
    },
    required: ['file_path', 'old_text', 'new_text'],
  },
  category: 'fs',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: true,
};

interface EditDryRunOutput {
  absPath: string;
  occurrences: number;
  wouldReplace: number;
  oldBytes: number;
  newBytes: number;
  bytesDelta: number;
  dryRun: true;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

class EditPocHandler implements ToolHandler<Record<string, unknown>, EditDryRunOutput> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<EditDryRunOutput>> {
    const file_path = args.file_path as string | undefined;
    const old_text = args.old_text as string | undefined;
    const new_text = args.new_text as string | undefined;
    const replace_all = Boolean(args.replace_all);

    if (!file_path || typeof file_path !== 'string') {
      return { ok: false, error: 'file_path 必须是字符串', code: 'INVALID_ARGS' };
    }
    if (typeof old_text !== 'string' || typeof new_text !== 'string') {
      return { ok: false, error: 'old_text 和 new_text 必须是字符串', code: 'INVALID_ARGS' };
    }
    if (old_text.length === 0) {
      return { ok: false, error: 'old_text 不能为空', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }

    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `dry-run edit ${path.basename(file_path)}` });

    const absPath = path.isAbsolute(file_path)
      ? file_path
      : path.resolve(ctx.workingDir, file_path);

    let raw: string;
    try {
      const stat = await fs.stat(absPath);
      const cached = ctx.fileCache?.get(absPath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        raw = cached.content;
      } else {
        raw = await fs.readFile(absPath, 'utf-8');
        ctx.fileCache?.set(absPath, raw, stat.mtimeMs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `read failed: ${msg}`, code: 'READ_FAILED' };
    }

    const occurrences = countOccurrences(raw, old_text);
    if (occurrences === 0) {
      return { ok: false, error: 'old_text not found', code: 'NOT_FOUND' };
    }
    if (occurrences > 1 && !replace_all) {
      return {
        ok: false,
        error: `old_text matches ${occurrences} occurrences but replace_all is false`,
        code: 'AMBIGUOUS_MATCH',
      };
    }

    const wouldReplace = replace_all ? occurrences : 1;
    const oldBytes = Buffer.byteLength(raw, 'utf-8');
    const lengthDelta = (new_text.length - old_text.length) * wouldReplace;
    const newBytes = oldBytes + Buffer.byteLength('a'.repeat(0)) + lengthDelta;
    // 简化：直接算 char delta * count，不重新构造完整新内容（dry-run 不需要）

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('EditPoc dry-run done', {
      absPath,
      occurrences,
      wouldReplace,
      bytesDelta: lengthDelta,
    });

    return {
      ok: true,
      output: {
        absPath,
        occurrences,
        wouldReplace,
        oldBytes,
        newBytes,
        bytesDelta: lengthDelta,
        dryRun: true,
      },
    };
  }
}

export const editPocModule: ToolModule<Record<string, unknown>, EditDryRunOutput> = {
  schema,
  createHandler() {
    return new EditPocHandler();
  },
};

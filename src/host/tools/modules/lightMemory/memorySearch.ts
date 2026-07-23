// ============================================================================
// memory_search — 把已有的 DB 记忆检索能力暴露给模型
//
// 背景（2026-07-23）：`image-ocr-search` / `photo-archive` 两个内置 skill 的 allowedTools
// 一直写着 memory_search，`ocr_search` 插件的描述里也写着「先 OCR 历史图片再用 memory_search
// 检索」——但**全仓根本没有这个工具**。结果是：OCR 文字与照片归档一直在往 memories 表写
// （type='ocr_result' / 'photo_archive'），模型却取不回来，是条写进去就找不回的半截链路。
//
// 检索本身早就有：databaseService.searchMemories()（FTS5 BM25，失败回落 LIKE），
// 已被 memoryEntryRuntime / workspaceArtifactIndexService / desktopActivityUnderstandingService
// 三处内部消费。这里只是补上工具外壳，不新造检索逻辑。
// ============================================================================

import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { getDatabase } from '../../../services/core/databaseService';
import { memorySearchSchema } from './memorySearch.schema';

const schema: ToolSchema = memorySearchSchema;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** 单条正文截断：memories 里塞过整段压缩上下文，不截会把窗口打爆 */
const SNIPPET_MAX_CHARS = 300;

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), MAX_LIMIT);
}

function snippet(record: { summary?: string; content: string }): string {
  const text = (record.summary?.trim() || record.content || '').replace(/\s+/g, ' ').trim();
  return text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}…` : text;
}

class MemorySearchHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(args: Record<string, unknown>, ctx: ToolContext, canUseTool: CanUseToolFn): Promise<ToolResult<string>> {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return { ok: false, error: 'query is required', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };

    const options = {
      ...(typeof args.type === 'string' && args.type ? { type: args.type } : {}),
      ...(typeof args.category === 'string' && args.category ? { category: args.category } : {}),
      limit: clampLimit(args.limit),
    };

    const records = getDatabase().searchMemories(query, options);
    if (records.length === 0) {
      return {
        ok: true,
        output:
          `没有匹配「${query}」的记忆。这里存的是历史 OCR 文字（ocr_result）、照片归档（photo_archive）`
          + '和上下文压缩落下的知识；文件式记忆请改用 MemoryRead。',
        meta: { count: 0 },
      };
    }

    const lines = records.map((record, index) => (
      `${index + 1}. [${record.type}${record.category ? ` · ${record.category}` : ''}] ${snippet(record)}`
    ));
    ctx.logger.debug('memory_search done', { query, count: records.length, type: options.type });

    return {
      ok: true,
      output: lines.join('\n'),
      meta: {
        count: records.length,
        records: records.map((record) => ({
          id: record.id,
          type: record.type,
          category: record.category,
          summary: snippet(record),
          sessionId: record.sessionId,
          updatedAt: record.updatedAt,
        })),
      },
    };
  }
}

export const memorySearchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new MemorySearchHandler(),
};

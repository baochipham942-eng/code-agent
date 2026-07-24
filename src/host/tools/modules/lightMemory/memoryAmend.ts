// ============================================================================
// memory_amend — 定向纠错/遗忘 DB-backed 记忆（MemoryRecord）
//
// 背景：写入 memories 表的自动化路径（flush-before-compaction / OCR 文字识别 /
// 照片归档等）只进不改——模型没法在用户指出"这条记错了"时就地修正或删除。
// 检索侧配对：memory_search（同一张 memories 表）。这里只补纠错/遗忘的工具外壳，
// 复用已有的 MemoryRepository.updateMemory/deleteMemory，不另造存储层。
//
// 注意：这个工具只管 DB 侧 MemoryRecord，不碰文件式记忆（那是 MemoryRead/MemoryWrite
// 的地盘，memory/*.md）。
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
import { memoryAmendSchema } from './memoryAmend.schema';

const schema: ToolSchema = memoryAmendSchema;

/** 纠正后重新派生的摘要长度上限，与 seedMemoryInjector 的展示口径一致 */
const SUMMARY_MAX_CHARS = 120;

class MemoryAmendHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(args: Record<string, unknown>, ctx: ToolContext, canUseTool: CanUseToolFn): Promise<ToolResult<string>> {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const action = args.action;

    if (!id) {
      return { ok: false, error: 'id is required', code: 'INVALID_ARGS' };
    }
    if (action !== 'update' && action !== 'forget') {
      return {
        ok: false,
        error: `Unknown action: "${String(action)}". Use "update" or "forget".`,
        code: 'INVALID_ARGS',
      };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };

    const db = getDatabase();
    const existing = db.getMemory(id);
    if (!existing) {
      return { ok: false, error: `No memory found with id "${id}".`, code: 'NOT_FOUND' };
    }

    if (action === 'forget') {
      db.deleteMemory(id);
      ctx.logger.info('memory_amend forget done', { id });
      return {
        ok: true,
        output: `Memory forgotten: ${id}`,
        meta: { action, id },
      };
    }

    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!content) {
      return { ok: false, error: 'update action requires: content', code: 'INVALID_ARGS' };
    }

    const summary = content.length > SUMMARY_MAX_CHARS ? `${content.slice(0, SUMMARY_MAX_CHARS)}…` : content;
    const updated = db.updateMemory(id, { content, summary });
    ctx.logger.info('memory_amend update done', { id });

    return {
      ok: true,
      output: `Memory updated: ${id}`,
      meta: { action, id, content: updated?.content },
    };
  }
}

export const memoryAmendModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new MemoryAmendHandler(),
};

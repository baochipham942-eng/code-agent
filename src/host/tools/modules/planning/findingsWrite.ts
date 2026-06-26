// ============================================================================
// FindingsWrite (P1 Wave 3 — planning: native ToolModule rewrite)
//
// 旧版: src/host/tools/planning/findingsWrite.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED /
//   DOMAIN_ERROR
// - 行为保真：legacy 输出 (Category/Title/ID/Total findings 行) 1:1 复刻
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { PlanningService, FindingCategory } from '../../../planning';
import { findingsWriteSchema as schema } from './findingsWrite.schema';

const VALID_CATEGORIES: readonly FindingCategory[] = [
  'code',
  'architecture',
  'dependency',
  'issue',
  'insight',
];

export async function executeFindingsWrite(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const category = args.category as FindingCategory | undefined;
  const title = args.title as string | undefined;
  const content = args.content as string | undefined;
  const source = args.source as string | undefined;

  if (!category || !VALID_CATEGORIES.includes(category)) {
    return {
      ok: false,
      error: `Invalid category: ${String(category)}. Must be one of: ${VALID_CATEGORIES.join(', ')}`,
      code: 'INVALID_ARGS',
    };
  }
  if (!title || title.trim().length === 0) {
    return {
      ok: false,
      error: 'title is required and cannot be empty',
      code: 'INVALID_ARGS',
    };
  }
  if (!content || content.trim().length === 0) {
    return {
      ok: false,
      error: 'content is required and cannot be empty',
      code: 'INVALID_ARGS',
    };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const planningService = ctx.planningService as PlanningService | undefined;
  if (!planningService) {
    return {
      ok: false,
      error:
        'Planning service not available. Cannot save findings. ' +
        'Make sure planning is enabled in the agent configuration.',
      code: 'NOT_INITIALIZED',
    };
  }

  try {
    await planningService.initialize();

    const finding = await planningService.findings.add({
      category,
      title: title.trim(),
      content: content.trim(),
      source,
    });

    const totalCount = await planningService.findings.getCount();

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('findings_write done', { id: finding.id });

    return {
      ok: true,
      output:
        `Finding saved to findings.md:\n\n` +
        `**Category:** ${category}\n` +
        `**Title:** ${title}\n` +
        `**ID:** ${finding.id}\n\n` +
        `Total findings: ${totalCount}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to save finding: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'DOMAIN_ERROR',
    };
  }
}

class FindingsWriteHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeFindingsWrite(args, ctx, canUseTool, onProgress);
  }
}

export const findingsWriteModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new FindingsWriteHandler();
  },
};

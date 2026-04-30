// ============================================================================
// WebSearch (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/web/webSearch.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy webSearchTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为直调 routeSources/searchSource，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { webSearchTool } from '../../web/webSearch';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { webSearchSchema as schema } from './webSearch.schema';

class WebSearchHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const query = typeof args.query === 'string' ? args.query : undefined;
    onProgress?.({ stage: 'starting', detail: query ? `WebSearch ${query.slice(0, 40)}` : 'WebSearch' });

    const legacyResult = await webSearchTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('WebSearch done', { ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const webSearchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WebSearchHandler();
  },
};

// ============================================================================
// web_fetch (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/web/webFetch.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy webFetchTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为直调 fetchDocument/extractOrTruncate，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { webFetchTool } from '../../web/webFetch';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { webFetchSchema as schema } from './webFetch.schema';

class WebFetchHandler implements ToolHandler<Record<string, unknown>, string> {
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

    const url = typeof args.url === 'string' ? args.url : undefined;
    onProgress?.({ stage: 'starting', detail: url ? `web_fetch ${url}` : 'web_fetch' });

    const legacyResult = await webFetchTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('web_fetch done', { url, ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const webFetchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WebFetchHandler();
  },
};

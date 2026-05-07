// ============================================================================
// Browser (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/vision/BrowserTool.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy BrowserTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为直调 browserService/browserActionTool，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { BrowserTool } from '../../vision/BrowserTool';
import { buildLegacyCtxFromProtocol } from '../_helpers/legacyAdapter';
import { browserSchema as schema } from './browser.schema';
import { adaptVisionLegacyResult } from './resultMeta';

class BrowserHandler implements ToolHandler<Record<string, unknown>, string> {
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

    const action = typeof args.action === 'string' ? args.action : undefined;
    onProgress?.({ stage: 'starting', detail: action ? `Browser ${action}` : 'Browser' });

    const legacyResult = await BrowserTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('Browser done', { action, ok: legacyResult.success });
    return adaptVisionLegacyResult(legacyResult, { tool: schema.name, args, ctx });
  }
}

export const browserModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new BrowserHandler();
  },
};

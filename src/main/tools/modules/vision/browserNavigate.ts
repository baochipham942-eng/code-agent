// ============================================================================
// browser_navigate (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/vision/browserNavigate.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy browserNavigateTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为直调 OS-level scripting，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { browserNavigateTool } from '../../vision/browserNavigate';
import { buildLegacyCtxFromProtocol } from '../_helpers/legacyAdapter';
import { browserNavigateSchema as schema } from './browserNavigate.schema';
import { adaptVisionLegacyResult } from './resultMeta';

class BrowserNavigateHandler implements ToolHandler<Record<string, unknown>, string> {
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
    onProgress?.({ stage: 'starting', detail: action ? `browser_navigate ${action}` : 'browser_navigate' });

    const legacyResult = await browserNavigateTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('browser_navigate done', { action, ok: legacyResult.success });
    return adaptVisionLegacyResult(legacyResult, { tool: schema.name, args, ctx });
  }
}

export const browserNavigateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new BrowserNavigateHandler();
  },
};

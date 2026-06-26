// ============================================================================
// computer_use (Level 1 native module — wrapper-mode)
//
// 旧版: src/host/tools/vision/computerUse.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy computerUseTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为直调 computerSurface/playwright，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { computerUseTool } from '../../../tools/vision/computerUse';
import { buildLegacyCtxFromProtocol } from '../../../tools/modules/_helpers/legacyAdapter';
import { computerUseSchema as schema } from './computerUse.schema';
import { adaptVisionLegacyResult } from '../../../tools/modules/vision/resultMeta';

class ComputerUseHandler implements ToolHandler<Record<string, unknown>, string> {
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
    onProgress?.({ stage: 'starting', detail: action ? `computer_use ${action}` : 'computer_use' });

    const legacyResult = await computerUseTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('computer_use done', { action, ok: legacyResult.success });
    return adaptVisionLegacyResult(legacyResult, { tool: schema.name, args, ctx });
  }
}

export const computerUseModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ComputerUseHandler();
  },
};

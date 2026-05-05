// ============================================================================
// Computer (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/vision/ComputerTool.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy ComputerTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为直调 screenshotTool/computerUseTool，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { ComputerTool } from '../../vision/ComputerTool';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { computerSchema as schema } from './computer.schema';

class ComputerHandler implements ToolHandler<Record<string, unknown>, string> {
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
    onProgress?.({ stage: 'starting', detail: action ? `Computer ${action}` : 'Computer' });

    const legacyResult = await ComputerTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('Computer done', { action, ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const computerModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ComputerHandler();
  },
};

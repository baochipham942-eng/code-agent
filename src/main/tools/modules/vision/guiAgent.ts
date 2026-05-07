// ============================================================================
// gui_agent (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/vision/guiAgent.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy guiAgentTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为直调 UI-TARS SDK，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { guiAgentTool } from '../../vision/guiAgent';
import { buildLegacyCtxFromProtocol } from '../_helpers/legacyAdapter';
import { guiAgentSchema as schema } from './guiAgent.schema';
import { adaptVisionLegacyResult } from './resultMeta';

class GuiAgentHandler implements ToolHandler<Record<string, unknown>, string> {
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

    const task = typeof args.task === 'string' ? args.task : undefined;
    onProgress?.({ stage: 'starting', detail: task ? `gui_agent ${task.slice(0, 40)}` : 'gui_agent' });

    const legacyResult = await guiAgentTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('gui_agent done', { task, ok: legacyResult.success });
    return adaptVisionLegacyResult(legacyResult, { tool: schema.name, args, ctx, defaultAction: 'run' });
  }
}

export const guiAgentModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new GuiAgentHandler();
  },
};

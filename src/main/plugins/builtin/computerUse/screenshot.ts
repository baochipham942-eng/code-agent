// ============================================================================
// screenshot (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/vision/screenshot.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy screenshotTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为直调 screencapture/visionAnalysisService，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { screenshotTool } from '../../../tools/vision/screenshot';
import { buildLegacyCtxFromProtocol } from '../../../tools/modules/_helpers/legacyAdapter';
import { screenshotSchema as schema } from './screenshot.schema';
import { adaptVisionLegacyResult } from '../../../tools/modules/vision/resultMeta';

class ScreenshotHandler implements ToolHandler<Record<string, unknown>, string> {
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

    const target = typeof args.target === 'string' ? args.target : 'screen';
    onProgress?.({ stage: 'starting', detail: `screenshot ${target}` });

    const legacyResult = await screenshotTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('screenshot done', { target, ok: legacyResult.success });
    return adaptVisionLegacyResult(legacyResult, { tool: schema.name, args, ctx, defaultAction: 'capture', target });
  }
}

export const screenshotModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ScreenshotHandler();
  },
};

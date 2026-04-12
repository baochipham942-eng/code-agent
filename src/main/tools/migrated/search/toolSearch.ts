// ============================================================================
// ToolSearch (P0-5 Migrated, wrapper mode)
//
// 旧版: src/main/tools/search/toolSearch.ts (registered as 'ToolSearch')
// 改造模式：wrapper — 委托给 legacy 实现，只做 4 参数签名 + canUseTool + ctx 适配
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { toolSearchTool } from '../../search/toolSearch';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';

const schema: ToolSchema = {
  name: 'ToolSearch',
  description: toolSearchTool.description,
  inputSchema: toolSearchTool.inputSchema,
  category: 'fs',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

class ToolSearchHandler implements ToolHandler<Record<string, unknown>, string> {
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

    onProgress?.({ stage: 'starting', detail: 'tool search' });
    const legacyResult = await toolSearchTool.execute(args, buildLegacyCtxFromProtocol(ctx));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('ToolSearch done', { ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const toolSearchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ToolSearchHandler();
  },
};

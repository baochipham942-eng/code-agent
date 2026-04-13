// ============================================================================
// SkillCreate (P0-5 Migrated, wrapper mode)
//
// 旧版: src/main/tools/skill/skillCreateTool.ts (registered as 'SkillCreate')
// wrapper 委托给 legacy 实现
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { skillCreateTool } from '../../skill/skillCreateTool';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { skillCreateSchema as schema } from './skillCreate.schema';

class SkillCreateHandler implements ToolHandler<Record<string, unknown>, string> {
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

    onProgress?.({ stage: 'starting', detail: 'create skill' });
    const legacyResult = await skillCreateTool.execute(args, buildLegacyCtxFromProtocol(ctx));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('SkillCreate done', { ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const skillCreateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new SkillCreateHandler();
  },
};

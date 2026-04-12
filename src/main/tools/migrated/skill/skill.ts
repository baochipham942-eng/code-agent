// ============================================================================
// Skill (P0-5 Migrated, wrapper mode)
//
// 旧版: src/main/tools/skill/skillMetaTool.ts (registered as 'Skill')
// wrapper 委托给 legacy。注意 Skill 的 fork 模式依赖 ctx.toolRegistry / ctx.modelConfig
// 这两个字段已通过 protocol ctx 的 legacyToolRegistry / modelConfig 透传，
// adapter 会反向映射回 legacy ctx 字段
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
import { skillMetaTool, getSkillToolDescription } from '../../skill/skillMetaTool';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';

const schema: ToolSchema = {
  name: 'Skill',
  description: skillMetaTool.description,
  // dynamicDescription: 透传 legacy 的动态描述生成器
  dynamicDescription: getSkillToolDescription,
  inputSchema: skillMetaTool.inputSchema,
  category: 'skill',
  permissionLevel: 'read',
  readOnly: false, // skill 可能触发 fork 副作用
  allowInPlanMode: false,
};

class SkillHandler implements ToolHandler<Record<string, unknown>, string> {
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

    const command = args.command as string | undefined;
    onProgress?.({ stage: 'starting', detail: command ? `skill ${command}` : 'skill' });

    const legacyResult = await skillMetaTool.execute(args, buildLegacyCtxFromProtocol(ctx));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('Skill done', { command, ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const skillModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new SkillHandler();
  },
};

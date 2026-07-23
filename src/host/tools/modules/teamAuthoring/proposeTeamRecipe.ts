import type { CanUseToolFn, ToolContext, ToolHandler, ToolModule, ToolProgressFn, ToolResult, ToolSchema } from '../../../protocol/tools';
import { SKILL_CATEGORIES } from '../../../../shared/constants/skillCatalog';
import type { TeamRecipeMember } from '../../../../shared/contract/teamRecipe';
import { validateTeamRecipe } from '../../../../shared/contract/teamRecipe';
import { getTeamRecipeService } from '../../../services/team/teamRecipeService';
import { enqueueTeamRecipeDraft } from '../../../services/team/teamRecipeDraftQueue';
import { proposeTeamRecipeSchema } from './proposeTeamRecipe.schema';

const schema: ToolSchema = proposeTeamRecipeSchema;
const categoryIds = new Set(SKILL_CATEGORIES.map((category) => category.id));

function members(value: unknown): TeamRecipeMember[] {
  if (!Array.isArray(value)) return [];
  return value.map((member) => {
    const item = member as Record<string, unknown>;
    return {
      ...(typeof item.id === 'string' && item.id.trim() ? { id: item.id.trim() } : {}),
      roleId: typeof item.roleId === 'string' ? item.roleId.trim() : '',
      taskTemplate: typeof item.taskTemplate === 'string' ? item.taskTemplate : '',
    };
  });
}

class ProposeTeamRecipeHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(args: Record<string, unknown>, ctx: ToolContext, canUseTool: CanUseToolFn, onProgress?: ToolProgressFn): Promise<ToolResult<string>> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    const category = typeof args.category === 'string' ? args.category : '';
    const rawLead = args.lead as Record<string, unknown> | undefined;
    const lead = rawLead ? {
      roleId: typeof rawLead.roleId === 'string' ? rawLead.roleId.trim() : '',
      briefTemplate: typeof rawLead.briefTemplate === 'string' ? rawLead.briefTemplate : '',
    } : undefined;
    if (!name || !description || !category || !Array.isArray(args.members)) {
      return { ok: false, error: 'name, description, category and members are required', code: 'INVALID_ARGS' };
    }
    if (!categoryIds.has(category as never)) {
      return { ok: false, error: `category is invalid: ${category}`, code: 'INVALID_ARGS' };
    }
    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };

    const recipe = { id: `draft-${Date.now()}`, name, description, category: category as never, members: members(args.members), lead };
    const knownRoleIds = await getTeamRecipeService().knownRoleIds();
    const errors = validateTeamRecipe(recipe, knownRoleIds);
    if (errors.length) {
      const unknown = errors.filter((error) => error.code === 'unresolvable-role');
      return { ok: false, error: `${errors.map((error) => error.reason).join('；')}${unknown.length ? '。文档里的这些角色本机没有对应专家：请换成已有专家，或先去建这个角色。' : ''}`, code: 'DRAFT_REJECTED' };
    }

    onProgress?.({ stage: 'starting', detail: `起草配方「${name}」` });
    const { draft, reason } = await enqueueTeamRecipeDraft({ ...recipe, sessionId: ctx.sessionId });
    if (!draft) return { ok: false, error: reason ?? '草稿入队失败', code: 'DRAFT_REJECTED' };
    ctx.emit({ type: 'team_recipe_draft_pending', data: { sessionId: ctx.sessionId, drafts: [draft] } });
    ctx.logger.info('propose_team_recipe drafted', { name, draftId: draft.id });
    onProgress?.({ stage: 'completing', percent: 100 });
    return { ok: true, output: `已生成「${name}」${lead ? '专家团' : '专家小组'}草稿，确认卡已弹出。用户确认前不会入库；需要修改时请带完整新定义重新起草。`, meta: { draftId: draft.id } };
  }
}

export const proposeTeamRecipeModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new ProposeTeamRecipeHandler(),
};

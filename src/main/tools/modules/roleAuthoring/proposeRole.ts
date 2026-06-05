// ============================================================================
// propose_role — 对话式建角色：模型起草角色定义 → 入队草稿 → 弹确认卡
//
// 模型在"建角色"会话里访谈完用户后调用本工具。工具把定义落成草稿
// （~/.code-agent/role-drafts/<id>/），并发射 role_draft_pending 事件让聊天
// 渲染确认卡。严禁自动入库：用户点确认（roles.ipc confirmDraft）才落 agents/<id>.md。
// 镜像 skillDraftQueue + skill_draft_pending 事件的范式（role-creation-flow §5）。
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
import type { SkillCategory } from '../../../../shared/contract/skillRepository';
import { enqueueRoleDraft } from '../../../services/roleAssets/roleDraftQueue';
import { proposeRoleSchema } from './proposeRole.schema';

const schema: ToolSchema = proposeRoleSchema;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

class ProposeRoleHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const roleId = typeof args.roleId === 'string' ? args.roleId.trim() : '';
    const systemPrompt = typeof args.systemPrompt === 'string' ? args.systemPrompt : '';
    const description = typeof args.description === 'string' ? args.description.trim() : '';
    const category = typeof args.category === 'string' ? (args.category as SkillCategory) : undefined;
    const tools = toStringArray(args.tools);

    if (!roleId) {
      return { ok: false, error: 'roleId is required', code: 'INVALID_ARGS' };
    }
    if (!systemPrompt.trim()) {
      return { ok: false, error: 'systemPrompt is required', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `起草角色「${roleId}」` });

    const { draft, reason } = await enqueueRoleDraft({
      roleId,
      description,
      category,
      tools,
      systemPrompt,
      sessionId: ctx.sessionId,
    });

    if (!draft) {
      // 入队被拒（重名/非法）——把原因回给模型，让它换名或调整后重试
      return { ok: false, error: reason ?? '草稿入队失败', code: 'DRAFT_REJECTED' };
    }

    // 发射事件 → 聊天渲染确认卡（RoleDraftNotifications 订阅 role_draft_pending）
    ctx.emit({
      type: 'role_draft_pending',
      data: {
        sessionId: ctx.sessionId,
        drafts: [
          {
            id: draft.id,
            roleId: draft.roleId,
            description: draft.description,
            category: draft.category,
            tools: draft.tools,
          },
        ],
      },
    });

    ctx.logger.info('propose_role drafted', { roleId: draft.roleId, draftId: draft.id });
    onProgress?.({ stage: 'completing', percent: 100 });

    const toolsLine = tools.length > 0 ? tools.join(', ') : '（默认全集）';
    return {
      ok: true,
      output:
        `已为「${draft.roleId}」生成草稿，确认卡已弹出，等待用户点击确认。\n` +
        `- 描述：${draft.description || '（无）'}\n` +
        `- 工具：${toolsLine}\n` +
        `请告诉用户：可以直接确认创建，或继续提出修改（你会重新起草）。在用户确认前不要重复调用本工具，除非用户要求改动。`,
      meta: {
        draftId: draft.id,
        roleId: draft.roleId,
        category: draft.category,
        tools: draft.tools,
      },
    };
  }
}

export const proposeRoleModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ProposeRoleHandler();
  },
};

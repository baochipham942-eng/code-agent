// ============================================================================
// propose_role — 对话式建角色：模型起草角色定义 → host 判定直接安装或弹确认卡
//
// 模型在"建角色"会话里访谈完用户后调用本工具。工具把定义落成草稿
// 用户自己的最新消息明确要求直接创建时，host 走与确认 IPC 共用的安装安全路径；
// 其余请求仍入队草稿并发射 role_draft_pending。
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
import type { Message, SessionOrigin } from '../../../../shared/contract';
import {
  enqueueRoleDraft,
  installRoleDraft,
  prepareRoleDraft,
} from '../../../services/roleAssets/roleDraftQueue';
import { buildRoleCreatedSummary } from '../../../services/roleAssets/roleCreatedSummary';
import { shouldCreateRoleDirectly } from '../../../services/roleAssets/roleCreationIntent';
import { getSessionManager } from '../../../services/infra/sessionManager';
import { getPermissionModeManager } from '../../../permissions/modes';
import { findUnknownToolNames, getKnownToolNames, hasProtocolToolRegistry } from '../../knownToolNames';
import { proposeRoleSchema } from './proposeRole.schema';

const schema: ToolSchema = proposeRoleSchema;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

function latestRealUserText(messages: readonly Message[]): string | null {
  return [...messages]
    .reverse()
    .find((message) => message.role === 'user' && message.visibility !== 'rewound' && !message.isMeta)
    ?.content.trim() || null;
}

function isExternalOrigin(origin: SessionOrigin | undefined): boolean {
  return origin !== undefined && origin.kind !== 'manual' && origin.kind !== 'retry';
}

async function shouldInstallDirectly(ctx: ToolContext, editingRoleId: string | undefined): Promise<boolean> {
  if (editingRoleId || ctx.neoTag || getPermissionModeManager().isUnattendedSession(ctx.sessionId)) return false;
  try {
    const sessionManager = getSessionManager();
    const [messages, session] = await Promise.all([
      sessionManager.getMessages(ctx.sessionId),
      sessionManager.getSession(ctx.sessionId, 1),
    ]);
    if (isExternalOrigin(session?.origin)) return false;
    const latestUserText = latestRealUserText(messages);
    return latestUserText !== null && shouldCreateRoleDirectly(latestUserText);
  } catch (error) {
    ctx.logger.warn('propose_role direct-intent lookup failed; falling back to confirmation', {
      sessionId: ctx.sessionId,
      error: String(error),
    });
    return false;
  }
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
    const userExpectation = typeof args.userExpectation === 'string' ? args.userExpectation.trim() : '';
    const editingRoleId =
      typeof args.editingRoleId === 'string' && args.editingRoleId.trim() ? args.editingRoleId.trim() : undefined;

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

    // 工具名必须真实存在：模型编造的名字不能落进 agents/*.md（此前只在启动期记 error，专家已建好）
    if (tools.length > 0) {
      if (hasProtocolToolRegistry()) {
        const unknown = findUnknownToolNames(tools, getKnownToolNames());
        if (unknown.length > 0) {
          ctx.logger.warn('propose_role rejected unknown tool names', { roleId, unknown: unknown.map((u) => u.name) });
          const lines = unknown.map((u) => {
            const near = u.suggestion ? [u.suggestion] : (u.nearest ?? []);
            return near.length ? `- ${u.name} (nearest real tools: ${near.join(', ')})` : `- ${u.name} (no similar real tool)`;
          },
          );
          return {
            ok: false,
            code: 'UNKNOWN_TOOLS',
            error:
              `These tool names do not exist, so no draft was created:\n${lines.join('\n')}\n` +
              'Fix the names using real tool names and call propose_role again. ' +
              'If no real tool provides the needed ability, tell the user in plain Chinese which ability is unavailable, ' +
              'and submit the draft without that tool.',
          };
        }
      } else {
        ctx.logger.warn('propose_role skipped tool-name validation: protocol tool registry not ready', { roleId });
      }
    }

    onProgress?.({ stage: 'starting', detail: `起草角色「${roleId}」` });

    const draftInput = {
      roleId,
      description,
      category,
      tools,
      systemPrompt,
      userExpectation,
      sessionId: ctx.sessionId,
      editingRoleId,
    };

    const direct = await shouldInstallDirectly(ctx, editingRoleId);
    if (direct) {
      const prepared = await prepareRoleDraft(draftInput);
      if (!prepared.draft || prepared.agentMd === undefined) {
        return { ok: false, error: prepared.reason ?? 'Role draft validation failed', code: 'DRAFT_REJECTED' };
      }
      const installed = await installRoleDraft(prepared.draft, prepared.agentMd);
      if (!installed.success) {
        return { ok: false, error: installed.error ?? 'Role installation failed', code: 'DRAFT_REJECTED' };
      }

      const summary = buildRoleCreatedSummary(prepared.draft);
      ctx.emit({
        type: 'role_created_direct',
        data: {
          sessionId: ctx.sessionId,
          roleId: prepared.draft.roleId,
          displayName: prepared.draft.roleId,
          canDo: summary.canDo,
          willNotDo: summary.willNotDo,
        },
      });
      ctx.logger.info('propose_role installed directly from explicit user intent', {
        roleId: prepared.draft.roleId,
      });
      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output:
          'The host already installed this role and queued its first wake. ' +
          'Do not announce that it was created, do not repeat its name, and do not add a confirmation message. ' +
          'End this role-authoring turn so the first-wake message can take over.',
        meta: {
          roleId: prepared.draft.roleId,
          sessionId: ctx.sessionId,
          displayName: prepared.draft.roleId,
          canDo: summary.canDo,
          willNotDo: summary.willNotDo,
          category: prepared.draft.category,
          tools: prepared.draft.tools,
          directCreated: true,
          endRunWithoutAssistant: true,
        },
      };
    }

    const { draft, reason } = await enqueueRoleDraft(draftInput);

    if (!draft) {
      // 入队被拒（重名/非法）——把原因回给模型，让它换名或调整后重试
      return { ok: false, error: reason ?? 'Role draft enqueue failed', code: 'DRAFT_REJECTED' };
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
            editingRoleId: draft.editingRoleId,
          },
        ],
      },
    });

    ctx.logger.info('propose_role drafted', { roleId: draft.roleId, draftId: draft.id });
    onProgress?.({ stage: 'completing', percent: 100 });

    const toolsLine = tools.length > 0 ? tools.join(', ') : '（默认全集）';
    const verb = editingRoleId ? '修改' : '创建';
    return {
      ok: true,
      output:
        `已为「${draft.roleId}」生成${editingRoleId ? '修改' : ''}草稿，确认卡已弹出，等待用户点击确认。\n` +
        `- 描述：${draft.description || '（无）'}\n` +
        `- 工具：${toolsLine}\n` +
        `请告诉用户：可以直接确认${verb}，或继续提出修改（你会重新起草）。在用户确认前不要重复调用本工具，除非用户要求改动。`,
      meta: {
        draftId: draft.id,
        roleId: draft.roleId,
        category: draft.category,
        tools: draft.tools,
        editingRoleId: draft.editingRoleId,
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

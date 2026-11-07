// ============================================================================
// RoleFlowStallExit — 建/改角色严格流程的停摆出口（FB-327）
// ----------------------------------------------------------------------------
// 真实故障：用户从「+ 新建角色」进入对话式建角色，模型念一段「第 1/4 步：分析需求」
// 之类的进度旁白后直接结束回合——既没有调用 propose_role（无草稿、无确认卡），也没有
// 留给用户一个待答的问句。会话就此空闲：用户以为在等它干活，其实流程已死，回复「确认」
// 也不会创建任何东西（落盘只能由用户在确认卡上点确认，而卡从未出现）。
//
// 本模块在轮末文本收尾处判定这个死局，落一条用户可见的 system 消息（登记制：
// USER_VISIBLE_SYSTEM_EVENT_REGISTRY 的 roleFlowStalled 键）说明「没有草稿」并给出
// 继续/放弃路径，替代静默空闲。判定谓词是纯函数，settle 只负责落消息与发事件。
// ============================================================================

import type { Message } from '../../../shared/contract';
import type { SystemEventMessageMetadata } from '../../../shared/contract/systemEventRegistry';
import type { SkillToolBoundary } from '../../../shared/contract/agentSkill';
import type { RuntimeContext } from './runtimeContext';
import { listRoleDrafts } from '../../services/roleAssets/roleDraftQueue';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentLoop');

/** 与 conversationRuntimeStickySkill 的 STICKY_STRICT_SKILL_NAMES 同一集合（建/改角色）。 */
const ROLE_AUTHORING_STRICT_SKILLS = new Set(['create-role', 'edit-role']);

const PROPOSE_ROLE_TOOL_NAME = 'propose_role';

/** 每个 run（ctx）按「最近一条 user 消息」记已落过说明的那一轮：同一轮 settle 重复调用不叠第二条，下一轮照常可落。 */
const stallSurfacedTurnByRun = new WeakMap<object, string>();

function latestUserMessageId(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i].id;
  }
  return '';
}

/**
 * 最近一次 /create-role|/edit-role 种子之后，历史里是否有成功的 propose_role 调用。
 * 有 = 流程已产出过草稿（之后被用户确认、移走或读盘失败都不再是「没产出」），
 * 此时 pending 草稿查不到不能判停摆。扫描方式对齐 conversationRuntimeStickySkill.hasExitedRoleFlowSince。
 */
function hasProposedRoleSinceSeed(messages: readonly Message[]): boolean {
  let seedIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user' && msg.visibility !== 'rewound' && /^\/(?:create-role|edit-role)(?:\s|$)/.test(msg.content.trim())) {
      seedIndex = i;
      break;
    }
  }
  const succeeded = new Set<string>();
  const proposeCallIds: string[] = [];
  for (let i = seedIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    for (const result of msg?.toolResults ?? []) {
      if (result.success) succeeded.add(result.toolCallId);
    }
    for (const call of msg?.toolCalls ?? []) {
      if (call.result?.success) succeeded.add(call.id);
      if (msg.role === 'assistant' && call.name === PROPOSE_ROLE_TOOL_NAME) proposeCallIds.push(call.id);
    }
  }
  return proposeCallIds.some((id) => succeeded.has(id));
}

/** settle 需要的宿主窄面：事件出口。 */
type RoleFlowStallContext = Pick<RuntimeContext, 'sessionId' | 'onEvent' | 'messages'>;

/** settle 需要的装配窄面：落卡消息持久化与消息 id 生成。 */
interface RoleFlowStallAssembly {
  addAndPersistMessage(message: Message): Promise<unknown>;
  generateId(): string;
}

export interface RoleFlowStallInput {
  readonly ctx: RoleFlowStallContext;
  readonly assembly: RoleFlowStallAssembly;
  readonly boundary: SkillToolBoundary | undefined;
  readonly finalText: string;
}

/**
 * 停摆判定（纯函数）：
 * - 建/改角色的 strict 边界仍激活（exit_role_flow 成功后边界会被清掉，天然排除显式退出）；
 * - 本会话没有 pending 角色草稿（有草稿 = 确认卡在场，空闲是正常等确认），
 *   且种子之后没有成功的 propose_role（草稿被确认/移走后查不到，不等于没产出）；
 * - 收尾文本里没有问句（？/?）——留给用户问题的一轮是合法访谈收尾，不打扰。
 */
function shouldSurfaceRoleFlowStall(
  boundary: SkillToolBoundary | undefined,
  finalText: string,
  hasPendingDraft: boolean,
  hasProposedRole: boolean,
): boolean {
  if (!boundary?.strict || !ROLE_AUTHORING_STRICT_SKILLS.has(boundary.skillName)) return false;
  if (hasPendingDraft || hasProposedRole) return false;
  return !/[?？]/.test(finalText);
}

function stallNoticeContent(skillName: string): string {
  const verb = skillName === 'edit-role' ? '改角色' : '建角色';
  return [
    `⚠️ ${verb}流程这一轮没有生成草稿（没有出现确认卡）。`,
    '上面的话只是文字说明，还没有任何角色被创建或修改。',
    `继续${verb}：直接回复一句话说明要什么样的角色；重新开始：发送 /create-role 或 /edit-role；不继续：聊别的即可，流程不会自动落盘。`,
  ].join('\n');
}

/**
 * 轮末文本收尾的兜底落点：判定成立时持久化并广播一条 role:'system' 的用户可见
 * 停摆说明（登记键 roleFlowStalled）。失败只记日志——出口本身不许把一轮正常收尾变红。
 */
export async function settleRoleFlowStallOnTextBreak(input: RoleFlowStallInput): Promise<boolean> {
  let hasPendingDraft = false;
  try {
    const drafts = await listRoleDrafts();
    hasPendingDraft = drafts.some((draft) => draft.sessionId === input.ctx.sessionId);
  } catch (error) {
    logger.warn('[AgentLoop] Role flow stall exit: listRoleDrafts failed, treating as no pending draft', {
      sessionId: input.ctx.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const turnKey = latestUserMessageId(input.ctx.messages);
  if (stallSurfacedTurnByRun.get(input.ctx) === turnKey) return false;
  if (!shouldSurfaceRoleFlowStall(input.boundary, input.finalText, hasPendingDraft, hasProposedRoleSinceSeed(input.ctx.messages))) {
    return false;
  }
  stallSurfacedTurnByRun.set(input.ctx, turnKey);

  const skillName = input.boundary?.skillName === 'edit-role' ? 'edit-role' : 'create-role';
  const message: Message = {
    id: input.assembly.generateId(),
    role: 'system',
    content: stallNoticeContent(skillName),
    timestamp: Date.now(),
    metadata: { roleFlowStalled: { skillName } } satisfies SystemEventMessageMetadata,
  };
  try {
    await input.assembly.addAndPersistMessage(message);
    input.ctx.onEvent({ type: 'message', data: message });
    logger.info('[AgentLoop] Role flow stall exit surfaced', { sessionId: input.ctx.sessionId, skillName });
    return true;
  } catch (error) {
    logger.warn('[AgentLoop] Role flow stall exit message not persisted', {
      sessionId: input.ctx.sessionId,
      skillName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

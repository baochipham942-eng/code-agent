// ============================================================================
// 通话态的专家路由（方案 §4.1 / §6.7）
//
// 语音沿用 ADR-052 的 turn 级身份：不给 voice_session 表加「唯一专家」字段，
// 只在运行态记「这一路通话默认由谁接」。身份来源是 Renderer——`preferredAgentId`
// （用户在输入框选中的专家）按会话存在 Renderer 的 localStorage 里，host 没有
// 存量可查，所以建连时随 WS query 传上来，与文本轮把它塞进 envelope 是同一个源。
// ============================================================================

import { resolveAgent } from '../../agent/agentRegistry';
import { getBuiltinRoleVisual } from '../roleAssets/builtinRoles';

export interface VoiceRoutingState {
  /** 默认收件人；无专家时 undefined = 会话默认 agent（自动路由） */
  activeAgentId?: string;
  /** 供 Realtime session.instructions 用的短人设；无专家时为空 */
  personaInstructions: string;
}

/** 通话 brain 的行为约束。和执行侧无关，只管「怎么说话、什么时候派活」。 */
const VOICE_BASE_INSTRUCTIONS = [
  '你是 Neo 的语音界面，正在和用户实时通话。',
  '说话简短口语化，一次只讲要点，不要念长列表或代码。',
  '需要真干活（读写文件、跑命令、多步任务）时调用 spawn_task 派给执行侧，不要自己编造文件内容或结果。',
  '危险操作由界面上的权限卡确认，你不能口头替用户放行。',
].join('\n');

/**
 * 短人设：只取花名 + 一句话职责 + 能力标签。
 *
 * 刻意**不**注入 buildRoleContextBlock() 的全量 L0/L1（角色记忆索引、履历、资料架）——
 * 那是执行 run 的事（隐私边界 + instructions 体量，方案 §6.7.3）。通话 brain 只需要
 * 知道自己是谁、不许冒充别人。
 *
 * 两个来源：云货架/内置角色走 getBuiltinRoleVisual，自定义 agent 走 registry 的
 * name + description。都没有就返回空——不编造人设。
 */
function buildShortPersona(agentId: string): string {
  const visual = getBuiltinRoleVisual(agentId);
  if (visual) {
    const duty = visual.tags.length ? `${visual.profession}（${visual.tags.join('、')}）` : visual.profession;
    return `你现在的身份是「${visual.displayName}」，${duty}。`;
  }
  const agent = resolveAgent(agentId);
  if (agent) {
    const duty = agent.description ? `，${agent.description}` : '';
    return `你现在的身份是「${agent.name}」${duty}。`;
  }
  return '';
}

/**
 * 建连时解析通话身份。
 *
 * requestedAgentId 来自 Renderer 的 activeAgentId：单专家会话 = 那位专家；
 * 用户没选 = undefined，走会话默认 agent。
 *
 * ⚠️ 团会话「默认收件人 = Lead」（D2）本批**没有实现**：本仓运行时不存在会话级的
 * lead 记录——`recipe.lead` 只在组队发起那一刻被当作主会话本轮的 agentOverrideId
 * 消费一次，之后没有任何地方记得「这个会话的 lead 是谁」。要兑现 D2 得先补一条
 * 会话级 lead 持久化，那是独立的一件事，不该塞进本批悄悄造一个假的。
 */
export function resolveVoiceRouting(requestedAgentId?: string): VoiceRoutingState {
  const activeAgentId = requestedAgentId?.trim() || undefined;
  if (!activeAgentId) return { personaInstructions: VOICE_BASE_INSTRUCTIONS };

  const persona = buildShortPersona(activeAgentId);
  const lines = [VOICE_BASE_INSTRUCTIONS];
  if (persona) {
    lines.push(persona, '保持这个身份说话，不要自称团队里的其他成员。');
  }
  return { activeAgentId, personaInstructions: lines.join('\n') };
}

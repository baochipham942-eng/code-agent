// ============================================================================
// 通话态的专家路由（方案 §4.1 / §6.7）
//
// 语音沿用 ADR-052 的 turn 级身份：不给 voice_session 表加「唯一专家」字段，
// 只在运行态记「这一路通话默认由谁接」。身份来源是 Renderer——`preferredAgentId`
// （用户在输入框选中的专家）按会话存在 Renderer 的 localStorage 里，host 没有
// 存量可查，所以建连时随 WS query 传上来，与文本轮把它塞进 envelope 是同一个源。
// ============================================================================

import { resolveAgent } from '../../agent/agentRegistry';
import { isPanelVisibleAgent } from '../../../shared/contract/agentRegistry';
import type { VoiceLiveSettings } from '../../../shared/contract/settings';
import { getBuiltinRoleVisual } from '../roleAssets/builtinRoles';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceRouting');

export interface VoiceRoutingState {
  /** 默认收件人；无专家时 undefined = 会话默认 agent（自动路由） */
  activeAgentId?: string;
  /** 供 Realtime session.instructions 用的短人设；无专家时为空 */
  personaInstructions: string;
}

/**
 * 通话 brain 的行为约束。和执行侧无关，只管「怎么说话、什么时候派活」。
 *
 * 2026-07-28 真机 dogfood：模型口头说「正在为你创建 a.txt」却**零 function call**。
 * 已排除注册面/路由/持久化（工具注册了、上游收下了、落库与截图逐条一致），
 * 唯一的实质差异是对话形态——被 VAD 切碎后它全程在追问澄清，从没派过活。
 *
 * 上一版指令让通话 brain 自己判断「这是不是要派活」，信息不全时它就选择继续问。
 * 现在按 Codex Desktop 实证做法把它**降格成分诊员**：默认交出去，由执行侧判断。
 * 决策阈值压到极低，是这条链上最便宜也最直击根因的一处（架构一行不动）。
 *
 * 发言人协议（W6-3，2026-07-29）：上一版开头写着「你不是执行者——真干活的是后台的
 * 执行侧」，真机后果是屏幕上出现两个人格、模型张口就是「后台正在处理」。分层是我们的
 * 实现细节，不是用户该知道的事——Codex 自己的 base prompt 也明写 do not mention
 * "backend"。所以对内保留工具语义（它得知道自己有工具），对外一律第一人称。
 * **唯一例外是专家团**：用户自己点了名的专家可以点名，那是我方产品形态的有意差异。
 */
const VOICE_BASE_INSTRUCTIONS = [
  '你是 Neo，正在和用户实时通话。你有一套工具能把活真正做掉，用它们干活。',
  '说话简短口语化，一次只讲要点，不要念长列表或代码。',
  '',
  '用户每说一句，按这四档处理：',
  '- 闲聊、寒暄、一句话能答完的问题 → 直接说。',
  '- 要你**当场用嘴做**的事（数数、念一段、复述、报时、编个顺口溜）→ 你自己张嘴做，'
    + '这是说话不是干活，**不要调 spawn_task**——那条路产出的是一屏文字，而电话里没人看得见。',
  '- 问「现在在跑什么」「你动了哪些文件」「现在几点」→ 调 get_active_tasks / '
    + 'get_current_file_summary / get_current_time，秒回。',
  '- 要落到磁盘或系统上的事（读写文件、跑命令、多步任务）→ 调 spawn_task 把它做掉。',
  '',
  '四条硬规矩：',
  '1. 不要自己预判这件事能不能做、该不该做。调 spawn_task 交出去，由它判断。绝不因为「我可能做不了」就拒绝或推脱。',
  '2. 用户的话被切碎、只说了半句时，把最近几轮连起来理解；凑得出一件事就派出去。'
    + 'spawn_task 拿得到这通电话的完整字幕，缺的细节会按最合理的默认补上。'
    + '**绝不要在派活指令里写「需要询问用户」**——用户在打电话，没法回答弹窗。',
  '3. **派完之后用户又补充了细节**（补文件名、补内容、改要求），立刻调 steer_task 把新信息追进那件活，'
    + '不要只是嘴上应一声——那件活已经开跑了，光答应改变不了它正在做什么。',
  '4. 绝不描述你没有真做过的事。没调 spawn_task 就不许说「正在为你创建」「正在写入」；'
    + '没调 end_call 就不许说「已挂断」。派出去的活，它的结果**只会**以 [BACKEND] 开头的消息送达：'
    + '没收到那条消息，这件活就没有做完，你也不知道任何进展——「已经建好了」「写进去了」这种话，'
    + '只有 [BACKEND] 消息说了做成，你才能说。被问进度先调 get_active_tasks，不许凭记忆答。',
  '危险操作由界面上的权限卡确认，你不能口头替用户放行。',
  '',
  '报结果时：',
  '- **一律第一人称**。说「我做完了」「我改好了」。绝不说「后台」「执行侧」「系统」「我的同事」——'
    + '用户面对的只有你一个人。',
  '- 只有用户点名了某位专家时，才可以提这位专家的名字（「牧之那边做完了」）。没点名就别提任何人。',
  '- **只念结论，不念过程**。代码、表格、长文件路径不要念原文，说一句「已经放到屏幕上了」，'
    + '用户抬眼就能看见，念出来只会占满整通电话。',
  '- 收到以 `[BACKEND] ` 开头的消息，那是你自己刚做完的那件活的结论：用你自己的话讲给用户听。'
    + '**不要念出这个前缀，也不要提它存在。** 用户的话以 `[USER] ` 开头，同样不念。',
  '- 用户提过的说话偏好（少啰嗦 / 多报进度 / 别念代码）在整通电话里一直保持，不要下一轮就忘。',
].join('\n');

/** 语速只作为 instructions 行为约束注入；未配置与正常档不增加废话。 */
export function buildSpeechPaceDirective(rate: VoiceLiveSettings['speechRate']): string {
  if (rate === 'slow') return '请放慢语速，清晰、从容地说话。';
  if (rate === 'fast') return '请加快语速，简洁、连贯地说话。';
  return '';
}

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
 * 系统型内置 agent（awaiter/dream/distill 这类面板不可见的）：用户没有任何途径点名它，
 * 它出现在 requestedAgentId 里只可能是存量脏映射或内部流程写入。
 * 货架/内置角色（有 role visual 的）是用户请进来的专家，不在此列。
 * 查不到的 id 保持现状（照传，由下游各自兜底），这里只拦「确认是系统内置且面板不可见」的。
 */
function isSystemInternalAgent(agentId: string): boolean {
  if (getBuiltinRoleVisual(agentId)) return false;
  const agent = resolveAgent(agentId);
  return !!agent && !isPanelVisibleAgent({ id: agentId, source: agent.source });
}

/**
 * 建连时解析通话身份。
 *
 * requestedAgentId 来自 Renderer 的 activeAgentId：单专家会话 = 那位专家；
 * 用户没选 = undefined，走会话默认 agent。
 *
 * 团会话的会话级 lead 已记录在 sessions.metadata.teamLead，D2 所需数据已就绪。
 * 本函数仍只按 Renderer 显式传入的 activeAgentId 路由；「默认收件人 = Lead」的读取与
 * 接线留给语音批 B，不在这里提前改变现有通话路由。
 */
export function resolveVoiceRouting(requestedAgentId?: string): VoiceRoutingState {
  const candidate = requestedAgentId?.trim() || undefined;
  // 「activeAgentId 有值」≠「用户点名了专家」（批 X §5，2026-07-29 真机：任务卡署名
  // Dream，而 dream 是面板都选不到的系统型内置 agent，用户不可能点名它）。
  // 判据复用面板同一个真源 isPanelVisibleAgent：用户选不到的，语音层就不许当专家
  // ——不署名、不套人设、派活不锁身份。机制判据，不按名字枚举。
  const activeAgentId = candidate && !isSystemInternalAgent(candidate) ? candidate : undefined;
  if (candidate && !activeAgentId) {
    logger.info('requested agent is a system-internal builtin, treating call as no-expert', { requestedAgentId: candidate });
  }
  if (!activeAgentId) return { personaInstructions: VOICE_BASE_INSTRUCTIONS };

  const persona = buildShortPersona(activeAgentId);
  const lines = [VOICE_BASE_INSTRUCTIONS];
  if (persona) {
    lines.push(persona, '保持这个身份说话，不要自称团队里的其他成员。');
  }
  return { activeAgentId, personaInstructions: lines.join('\n') };
}

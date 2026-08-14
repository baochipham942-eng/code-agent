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
import { readPersistedTeamLead } from '../../../shared/contract/teamRecipe';
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
  '用户要求派活时，本轮第一个输出必须是 delegate_task function call；工具成功返回前禁止先语音答应。',
  '说话简短口语化，一次只讲要点，不要念长列表或代码。',
  '',
  '',
  '**先分清这段声音是不是在跟你说话。** 话筒会收进电视、外放视频、旁边人的聊天——',
  '这些不是对你说的。判据是对方有没有在跟你交流：称呼你、向你提问或下指令、接着你刚才的话说。',
  '确认不是对你说的（新闻播报、天气预报、影视对白、旁人闲聊）就调 ignore_turn，然后不要再说话。',
  '**拿不准就正常回应**——把用户真说的话当背景音忽略掉，比多搭一句话糟得多。',
  '',
  '确认是在跟你说话之后，按这四档处理：',
  '- 闲聊、寒暄、一句话能答完的问题 → 直接说。',
  '- 要你**当场用嘴做**的事（数数、念一段、复述、报时、编个顺口溜）→ 你自己张嘴做，'
    + '这是说话不是干活，**不要调 delegate_task**——那条路产出的是一屏文字，而电话里没人看得见。',
  '- 问「现在在跑什么」「你动了哪些文件」「现在几点」→ 调 task_status / '
    + 'get_current_file_summary / get_current_time，秒回。',
  '- 要落到磁盘或系统上的事（读写文件、跑命令、多步任务）→ 调 delegate_task 把它做掉。',
  '',
  '四条硬规矩：',
  '1. 不要自己预判这件事能不能做、该不该做。调 delegate_task 交出去，由它判断。绝不因为「我可能做不了」就拒绝或推脱。',
  '2. 用户的话被切碎、只说了半句时，把最近几轮连起来理解；凑得出一件事就派出去。'
    + 'delegate_task 拿得到这通电话的完整字幕，缺的细节会按最合理的默认补上。'
    + '**绝不要在派活指令里写「需要询问用户」**——用户在打电话，没法回答弹窗。',
  '3. **派完之后用户又补充了细节**（补文件名、补内容、改要求），立刻调 steer_task 把新信息追进那件活，'
    + '不要只是嘴上应一声——那件活已经开跑了，光答应改变不了它正在做什么。',
  '3b. **有活在跑时，先分清用户是要「改」还是要「换」**：',
  '   - 还要那件活，只是要求变了 →「顺便把标题也改了」「不是这样，应该用中文」→ steer_task。',
  '   - 不要那件活了，改做另一件 →「别等它了，先帮我建个文件」「算了，换成写周报」「停下，改做…」'
    + '→ delegate_task 并传 replace_current=true。',
  '   判据是**旧的那件还要不要**：还要就 steer，不要了就 replace。分不清就问一句「那件还要吗」，'
    + '别自己挑一个——挑错的代价是用户的活被白扔掉，或者两件活一起跑。',
  '4. 绝不描述你没有真做过的事。没调 delegate_task 就不许说「正在为你创建」「正在写入」；'
    + '没调 end_call 就不许说「已挂断」。派出去的活，它的结果**只会**以 [BACKEND] 开头的消息送达：'
    + '没收到那条消息，这件活就没有做完，你也不知道任何进展——「已经建好了」「写进去了」这种话，'
    + '只有 [BACKEND] 消息说了做成，你才能说。被问进度先调 task_status，不许凭记忆答。',
  '4b. 用户一次要求多件事时，每件事分别调用一次 delegate_task，收到每次工具成功返回后再说派发结果。'
    + '只说「已派出」不算派发；工具没返回成功就必须如实说没有派出。',
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

/**
 * 用户明确点名派发工具，或对已派任务发出改向/查询/取消指令时，把这一轮提升为
 * 协议级 required tool call。后者若仍留在 auto，Realtime 模型可能只口头答应，
 * 后台任务却继续跑旧方向。
 *
 * 普通自然语言仍交给通话模型判断；这里刻意只认“调用/使用 + 派发工具名”的窄表达，
 * 防止把“别派任务”“delegate_task 是什么”之类讨论误变成真实执行。
 */
export interface VoiceActionRoute {
  toolName: 'steer_task' | 'task_status' | 'cancel_task';
  rawArguments: string;
}

function explicitTarget(prefix: string): string | undefined {
  const target = prefix
    .replace(/^(?:请|麻烦|现在|把|帮我|给我)+/u, '')
    .replace(/(?:的)?$/u, '')
    .trim();
  return target && target.length <= 12 ? target : undefined;
}

/**
 * Qwen Omni Realtime 的 tool_choice 只支持 auto/none，无法用 required 约束控制轮。
 * 明确的改项、状态和取消语句在 Host 侧直接落到窄工具；派新任务仍由模型补齐结构化参数。
 */
export function resolveVoiceActionRoute(text: string): VoiceActionRoute | undefined {
  const normalized = text.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!normalized) return undefined;

  const steer = /^(.*?)(?:那件|这件|任务|活).{0,16}(?:继续)?(?:改成|改为|调整为|补充|追加)/u.exec(normalized)
    ?? /^(.*?)(?:继续|顺便|再).{0,8}(?:改成|改为|调整|补充|追加)/u.exec(normalized);
  if (steer) {
    const target = explicitTarget(steer[1] ?? '');
    return {
      toolName: 'steer_task',
      rawArguments: JSON.stringify({ instruction: text.trim(), ...(target ? { target } : {}) }),
    };
  }

  if (/(?:那件|这件|任务|活).{0,12}(?:怎么样|怎样了|什么状态|进度|好了吗|做完了吗)/u.test(normalized)) {
    return { toolName: 'task_status', rawArguments: '{}' };
  }

  const cancel = /(?:停掉|停止|取消)(.*)$/u.exec(normalized);
  if (cancel && /(?:一个|这件|那件|任务|活)/u.test(cancel[1] ?? '')) {
    const target = explicitTarget((cancel[1] ?? '').replace(/^(?:一个|这件|那件)/u, '').replace(/(?:任务|活)$/u, ''));
    return { toolName: 'cancel_task', rawArguments: JSON.stringify(target ? { target } : {}) };
  }

  return undefined;
}

export function requiresVoiceActionTool(text: string): boolean {
  if (resolveVoiceActionRoute(text)) return true;
  const normalized = text.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!normalized) return false;
  // 这里匹配的是 normalized 形态（已去掉空格/下划线/连字符并小写），所以工具改名时
  // 按 `spawn_task` / `spawnTask` 做的全仓替换扫不到它——2026-08-08 改名就漏在这里，
  // 靠 voiceSpeakerProtocol 的用例才照出来。新增派活工具名必须同步这一条。
  // 旧名 spawntask 保留：用户和模型都可能沿用旧叫法。
  const dispatchMention = /(?:调用|使用).{0,24}(?:delegatetask|spawntask|派发任务工具)/u.exec(normalized);
  if (dispatchMention?.index === undefined) return false;
  const prefix = normalized.slice(Math.max(0, dispatchMention.index - 6), dispatchMention.index);
  return !/(?:不要|别|无需|禁止|不能|不许)$/u.test(prefix);
}

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
 * 团会话的默认收件人 = 会话级 lead（sessions.metadata.teamLead，组队发起时写入）。
 *
 * 判据比显式点名严一档：显式传上来的 id 查不到时照传（下游各自兜底），因为那是用户
 * 自己选的，我们没有推翻它的依据；默认收件人反过来——**没有任何人点过名**，是我们
 * 替用户认的人，认错就是让一位他没选的专家接了电话。所以这里 fail-closed：
 * 解析不出真身、或解析出来是面板选不到的系统型内置，一律回落无专家基线，宁少不多。
 */
function resolveTeamLeadDefault(sessionMetadata?: Record<string, unknown>): string | undefined {
  const roleId = readPersistedTeamLead(sessionMetadata)?.roleId;
  if (!roleId) return undefined;
  if (!getBuiltinRoleVisual(roleId) && !resolveAgent(roleId)) {
    logger.info('team lead is not resolvable, treating call as no-expert', { teamLeadRoleId: roleId });
    return undefined;
  }
  if (isSystemInternalAgent(roleId)) {
    logger.info('team lead is a system-internal builtin, treating call as no-expert', { teamLeadRoleId: roleId });
    return undefined;
  }
  return roleId;
}

/**
 * 建连时解析通话身份。
 *
 * requestedAgentId 来自 Renderer 的 activeAgentId：单专家会话 = 那位专家；
 * 用户没选 = undefined。
 *
 * 优先级（语音批 B）：显式 activeAgentId > 会话 metadata.teamLead > 无专家基线。
 * 团会话里用户不点名就直接打过来时，接电话的是主理人——和文本路径同一个真源
 * （readPersistedTeamLead，成员条的 isLead 也读它），署名/人设因此自动一致。
 *
 * sessionMetadata 由调用方（建连处）取好传进来：本函数保持纯函数，不开 DB。
 */
export function resolveVoiceRouting(
  requestedAgentId?: string,
  sessionMetadata?: Record<string, unknown>,
): VoiceRoutingState {
  const candidate = requestedAgentId?.trim() || undefined;
  // 「activeAgentId 有值」≠「用户点名了专家」（批 X §5，2026-07-29 真机：任务卡署名
  // Dream，而 dream 是面板都选不到的系统型内置 agent，用户不可能点名它）。
  // 判据复用面板同一个真源 isPanelVisibleAgent：用户选不到的，语音层就不许当专家
  // ——不署名、不套人设、派活不锁身份。机制判据，不按名字枚举。
  const explicitAgentId = candidate && !isSystemInternalAgent(candidate) ? candidate : undefined;
  if (candidate && !explicitAgentId) {
    logger.info('requested agent is a system-internal builtin, treating call as no-expert', { requestedAgentId: candidate });
  }
  // 显式 id 被判成脏映射时**继续往下走 lead 默认**：那本来就不是用户点的名，
  // 「用户没点名」正是 lead 默认要接管的情形。
  const activeAgentId = explicitAgentId ?? resolveTeamLeadDefault(sessionMetadata);
  if (!activeAgentId) return { personaInstructions: VOICE_BASE_INSTRUCTIONS };

  const persona = buildShortPersona(activeAgentId);
  const lines = [VOICE_BASE_INSTRUCTIONS];
  if (persona) {
    lines.push(persona, '保持这个身份说话，不要自称团队里的其他成员。');
  }
  return { activeAgentId, personaInstructions: lines.join('\n') };
}

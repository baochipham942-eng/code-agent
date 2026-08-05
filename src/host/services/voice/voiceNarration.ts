// ============================================================================
// 发言人协议 · 「念什么 / 以谁的身份念」（W6-1）
//
// 拆成独立模块而不是塞进 voiceAgentCoordinator：裁剪规则是这条链上唯一能被
// 纯函数钉死的部分（W6-6 门直接喂输入验输出），而 coordinator 带模块级账本单例，
// 拉进单测要连 TaskManager 一起 mock。
//
// 边界：这里只算「念什么」。播不播、什么时候播是 voiceSessionService 的节制闸（W6-4）。
// ============================================================================

import type { VoiceWorkNarration } from '../../../shared/contract/voice';
import { VOICE_NARRATION_MAX_CHARS } from '../../../shared/constants/voice';
import { resolveAgent } from '../../agent/agentRegistry';
import { getBuiltinRoleVisual } from '../roleAssets/builtinRoles';

/** 代码块 / 表格换成一句指路，绝不念原文——这是 W6-3 prompt 规则的确定性那一半。 */
const SPOKEN_PLACEHOLDER = {
  code: '（代码已经放到屏幕上了）',
  table: '（表格已经放到屏幕上了）',
} as const;

/**
 * 结论文本 → 能用嘴说的话。
 *
 * 刻意不做「智能摘要」（那是又一次模型调用 + 又一次延迟）：只做**减法**，
 * 把念出来会灾难的东西（代码、表格、绝对路径、超长正文）换成一句指路。
 * 减法是可验证的；摘要不是。
 */
export function toSpokenSummary(raw: string): string {
  let text = raw.trim();
  if (!text) return '';

  // 1) 围栏代码块。第二个分支管未闭合的尾块——模型被截断时很常见，
  //    只写闭合那一版的话，半截代码会原样念出去（变异验证过，去掉这个分支门当场转红）。
  text = text.replace(/```[\s\S]*?```|```[\s\S]*$/g, SPOKEN_PLACEHOLDER.code);

  // 2) markdown 表格：连续的 | 起头行整段换掉
  text = text.replace(/(^\|.*\|[ \t]*$\n?){2,}/gm, `${SPOKEN_PLACEHOLDER.table}\n`);

  // 3) 绝对路径只留文件名。念 /Users/x/Downloads/ai/code-agent/src/... 没有任何人听得进去。
  text = text.replace(/(?:[A-Za-z]:)?[/\\](?:[\w.\-@]+[/\\]){2,}([\w.\-@]+)/g, '$1');

  // 4) 行内 markdown 标记：念出来是噪音，去掉标记保留字。
  text = text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '');

  text = text.replace(/\n{2,}/g, '\n').trim();

  if (text.length <= VOICE_NARRATION_MAX_CHARS) return text;
  // 截在句末，别把话切在半个词上；找不到句末就硬截。
  const head = text.slice(0, VOICE_NARRATION_MAX_CHARS);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('. '));
  return `${cut > VOICE_NARRATION_MAX_CHARS / 2 ? head.slice(0, cut + 1) : head}…剩下的在屏幕上。`;
}

/**
 * 署名。**没有专家就返回 undefined**——语音层用第一人称说话，
 * 「后台/执行侧/我的同事」这类转述已在 §2.1 废弃。查不到名字的 agentId 同样返回
 * undefined：编一个显示名比不署名更糟。
 */
export function resolveNarrationSpeaker(agentId?: string): VoiceWorkNarration['speaker'] {
  if (!agentId) return undefined;
  const displayName = getBuiltinRoleVisual(agentId)?.displayName ?? resolveAgent(agentId)?.name;
  return displayName ? { agentId, displayName } : undefined;
}

/**
 * 「停旧的」这个动作的四种回报（§1 打断异步确认）。
 *
 * 为什么台词整句在这里算好、而不是像终态那样在 formatNarration 里按状态拼：终态只有
 * 三档且措辞已经稳定，而这四句的差别全在「新活派了没有」这个事实上——把它们劈成
 * 「状态在契约里、措辞在 session 层」两半，就是给「说了停下其实没停」这类谎报留门。
 * 一句话一个分支，整句可读，测试直接喂 kind 验字面量。
 */
export type VoiceStopAnnouncementKind =
  /** 纯 cancel：旧的确认停稳了，没有新活 */
  | 'stopped'
  /** replace：旧的收尾了，新活已经开跑 */
  | 'replaced'
  /** 纯 cancel 超时：没停稳 */
  | 'stop_timeout'
  /** replace 超时：没停稳，**且新活没派**——这句必须说清楚，否则用户以为新活在跑 */
  | 'replace_timeout';

const STOP_ANNOUNCEMENT_LINES: Record<VoiceStopAnnouncementKind, (title: string) => string> = {
  stopped: (title) => `现在对用户说：「『${title}』已经停下来了。」就说这一个意思。`,
  replaced: (title) => [
    `现在对用户说：「手上那件已经收尾了，我开始做『${title}』了，做完马上告诉你。」`,
    `关于『${title}』你目前只知道「已经开始」。它的结果只会以 [BACKEND] 开头的消息送达；`,
    '在收到那条消息之前，它没有做完，你也不知道任何进展。被问进度先调 task_status。',
  ].join('\n'),
  ['stop_timeout']: (title) => [
    `现在如实对用户说：「『${title}』我没能确认它停下来，它可能还在跑。」`,
    '不要说它已经停了。要停就请用户再说一次。',
  ].join('\n'),
  ['replace_timeout']: (title) => [
    `现在如实对用户说：「手上那件我没能确认它停下来，所以『${title}』我没有开始做。」`,
    '**这两件事都要说**：旧的没停稳、新的没派。绝不要说新的已经开始，也不要说旧的已经停了。',
    '要做就请用户再说一次。',
  ].join('\n'),
};

/**
 * 组装「停旧的」回报事件。
 *
 * `workItemId` 必须与任何真实 work item 的 id **不同**——注入通道按 workItemId 去重
 * （`spokenWorkItemIds`），拿新活的 id 播这句，会让那件活真正的终态回流被当成重复丢掉。
 * 调用方负责传后缀过的合成 id，这里只做拼装。
 */
export function buildStopNarration(input: {
  workItemId: string;
  kind: VoiceStopAnnouncementKind;
  title: string;
  agentId?: string;
}): VoiceWorkNarration {
  const speaker = resolveNarrationSpeaker(input.agentId);
  return {
    workItemId: input.workItemId,
    status: 'announcement',
    title: input.title,
    summary: STOP_ANNOUNCEMENT_LINES[input.kind](input.title),
    ...(speaker ? { speaker } : {}),
  };
}

/**
 * 中途进度台词（§2）。
 *
 * 只念**刚做完的那一步**，不念整个清单——电话里没人能记住五条待办。
 * 措辞刻意不带任何完成语义的名词（「已完成」「已结束」），因为整件活还没做完；
 * 本仓栽过三次「可润色的状态名词被润成已完成」。
 */
export function buildMilestoneNarration(input: {
  workItemId: string;
  title: string;
  step: string;
  agentId?: string;
  /**
   * 同时有不止一件活没落终态：这一句必须点名是哪件的进度。
   *
   * 只在多活时点名，不是无脑都带上：只有一件活在跑时说「『写周报』这边，草稿列完了」，
   * 是在回答没有人问的问题。归属信息的价值全部来自「有歧义」这个前提。
   */
  attributed?: boolean;
}): VoiceWorkNarration {
  const speaker = resolveNarrationSpeaker(input.agentId);
  const step = toSpokenSummary(input.step);
  const progress = input.attributed
    ? `「${input.title}」这边，${step}，这步做完了，我接着往下做。`
    : `${step}，这步做完了，我接着往下做。`;
  return {
    workItemId: input.workItemId,
    status: 'milestone',
    title: input.title,
    summary: [
      `现在对用户说一句进度：「${progress}」`,
      '**整件事还没做完**，不要说它完成了、写好了、可以用了。',
      '就说这一句，不要顺带汇报别的步骤，也不要念待办清单。',
    ].join('\n'),
    ...(speaker ? { speaker } : {}),
  };
}

/**
 * 执行侧卡住了（R3 worth-hearing）。
 *
 * 与 buildMilestoneNarration 同属 `milestone` 档——它同样是过程量，同样归节制闸管，
 * 只是带上 `worthHearing` 让闸松两格。**不另起一档状态**：新开一档就等于新开一条
 * 播报出口，而这条链上「执行侧能不能直接对用户说话」的答案必须一直是不能。
 *
 * 措辞要同时挡住两种润色：不能被润成「做完了」（它没做完），也不能被润成「失败了」
 * （它没失败，是推不动了，用户一句话就可能解开）。所以两句话都写死在这里。
 */
export function buildBlockedNarration(input: {
  workItemId: string;
  title: string;
  /** 已过 describeTaskBlockedReason 清洗的人话；模型贴的是日志时为空串。 */
  reason: string;
  subject: string;
  agentId?: string;
}): VoiceWorkNarration {
  const speaker = resolveNarrationSpeaker(input.agentId);
  const reason = toSpokenSummary(input.reason);
  // 原因为空 = 执行侧写的是机器噪音，被清洗层剥掉了。这时只说卡在哪一步，
  // 绝不用「未知原因」之类的话填坑——编一个原因比不说原因糟。
  const because = reason ? `：${reason}` : '';
  return {
    workItemId: input.workItemId,
    status: 'milestone',
    worthHearing: true,
    title: input.title,
    summary: [
      `现在对用户说：「『${input.title}』这边卡住了，卡在「${input.subject}」这一步${because}。」`,
      '**这件事既没有做完，也不算失败**，是推不动了停在这儿。不要说它完成了，也不要说它失败了。',
      '如果这事需要用户拿主意或者给点什么，就顺带问他一句；否则就说到这里，不要替他决定。',
    ].join('\n'),
    ...(speaker ? { speaker } : {}),
  };
}

/** 组装终态回流事件。summary 为空（模型一句话没留）时也照发——状态本身就是结论。 */
export function buildWorkNarration(input: {
  workItemId: string;
  status: Exclude<VoiceWorkNarration['status'], 'announcement'>;
  title: string;
  conclusion: string;
  agentId?: string;
}): VoiceWorkNarration {
  const speaker = resolveNarrationSpeaker(input.agentId);
  return {
    workItemId: input.workItemId,
    status: input.status,
    title: input.title,
    summary: toSpokenSummary(input.conclusion),
    ...(speaker ? { speaker } : {}),
  };
}

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

/** 组装终态回流事件。summary 为空（模型一句话没留）时也照发——状态本身就是结论。 */
export function buildWorkNarration(input: {
  workItemId: string;
  status: VoiceWorkNarration['status'];
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

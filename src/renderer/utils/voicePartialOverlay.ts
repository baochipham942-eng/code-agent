// ============================================================================
// 通话 partial 字幕的投影叠加（批 H）
//
// 批 B 把 partial 渲染成输入框上方一条独立的临时行：说的时候在框上滚，说完那行消失、
// 500ms 后 final 落库回来才变成气泡——用户看到的是「两个地方」＋一次闪断。
// 这里改成在消息流里原地流式改写：partial 直接投成一条**临时气泡**接在流尾，
// final 落库后由真消息无缝接手。
//
// 两条硬约束：
//   1) 节点 id / turnId 必须**恒定**。换 id 就是重挂载，会把列表高度打塌
//      （2026-07-27 批 F 的 F3 根因就是流式节点换 id 重挂载，heightlog 实锤 2795→602→2764）。
//   2) 仍然**不进 projection 的持久化侧**（§7.5 单一生产者）：这里只在渲染前叠加，
//      不写 sessionStore、不造 message。落库永远只有 host 一个生产者。
// ============================================================================

import type { TraceNode, TraceProjection, TraceTurn } from '@shared/contract/trace';

export const VOICE_PARTIAL_TURN_ID = 'voice-live-partial';
// 节点 id 是实现细节，不导出（knip 零余量：多一个孤儿导出就红）。
const VOICE_PARTIAL_USER_NODE_ID = 'voice-partial-user';
const VOICE_PARTIAL_ASSISTANT_NODE_ID = 'voice-partial-assistant';

export interface VoicePartialOverlayInput {
  /** 只有「这条会话正在通话中」才叠加 */
  live: boolean;
  user: string;
  assistant: string;
  startedAt: number | null;
}

/**
 * 真消息上屏后，决定撤掉哪几条临时气泡。
 *
 * 只撤「顶着的那句还没被新 partial 覆盖」的——用户说完上一句、真消息还没回来的空档里
 * 又开口了是常事，无脑清空会把正在说的下一句一起抹掉（然后从半截重新长）。
 *
 * `landed` = 真消息是否已经进了消息流。**撤气泡必须等它为真**：host 落库是异步的，
 * 只按「文本没被覆盖」就撤，会撤出一段两边都没有这句话的空帧——真机表现为
 * 助手回复「突然清空 → 再出现」（R1 交接闪断，2026-07-30）。
 */
export function resolvePartialRelease(
  settled: { user?: string; assistant?: string },
  current: { user: string; assistant: string },
  landed: { user: boolean; assistant: boolean },
): { partialUser?: string; partialAssistant?: string } {
  const patch: { partialUser?: string; partialAssistant?: string } = {};
  const release = (settledText: string | undefined, currentText: string, hasLanded: boolean): string | undefined => {
    if (!hasLanded || settledText === undefined) return undefined;
    const settledTrimmed = settledText.trim();
    const currentTrimmed = currentText.trim();
    if (!settledTrimmed || !currentTrimmed) return undefined;
    if (currentTrimmed === settledTrimmed) return '';
    // host 的连续 user final 会合并成「前缀 + 空格 + 当前段」；落地后只剥掉
    // 已经进真消息的前缀，保留仍在临时气泡里的下一段。
    if (!currentTrimmed.startsWith(settledTrimmed)) return undefined;
    const boundary = currentTrimmed[settledTrimmed.length];
    if (!boundary || !/\s/.test(boundary)) return undefined;
    return currentTrimmed.slice(settledTrimmed.length).trimStart();
  };
  const userRemainder = release(settled.user, current.user, landed.user);
  if (userRemainder !== undefined) patch.partialUser = userRemainder;
  const assistantRemainder = release(settled.assistant, current.assistant, landed.assistant);
  if (assistantRemainder !== undefined) patch.partialAssistant = assistantRemainder;
  return patch;
}

/**
 * 助手字幕该揭示到第几个字（批 X5.5-A4）。
 *
 * 判据是**音频播放进度**，不是 delta 到达进度：上游按生成速度吐转写、按生成速度下发音频，
 * 但音频要按真实时间播——两者差约 5 倍，照 delta 到达上屏字幕就跑在语音前面 20 多秒。
 * 已播比例用「已入队音频时长」作分母：文本和音频是同一次生成的产物，
 * 播了几成音频就等于念了几成文本，比例天然自校正，不需要猜语速。
 *
 * 分母为 0（音频还没开始/拿不到）时揭示 0 —— 调用方负责 fail-open 与停滞兜底，
 * 这里只做纯计算，不替调用方决定「等不到怎么办」。
 *
 * ponytail: 分母用「已入队」而不是「总时长」，因为总时长要等音频下发完才知道。
 * 代价是下发阶段（实测约前 4.3 秒）字幕会略微领先真实语音，实测峰值 15/124 字
 * （t=1s），到下发结束归零，之后完全贴合、零漂移。要抹掉这段领先只能引入
 * 「标称语速」常量去估总时长，那正是拍板时否掉的调参债，所以留着这个上限。
 */
export function computeRevealedSubtitle(target: string, enqueuedSec: number, playedSec: number): string {
  if (enqueuedSec <= 0) return '';
  const ratio = Math.min(1, Math.max(0, playedSec / enqueuedSec));
  return target.slice(0, Math.round(target.length * ratio));
}

export function applyVoicePartialsToProjection(
  projection: TraceProjection,
  input: VoicePartialOverlayInput,
): TraceProjection {
  if (!input.live) return projection;
  const hasUser = Boolean(input.user.trim());
  const hasAssistant = Boolean(input.assistant.trim());
  if (!hasUser && !hasAssistant) return projection;

  // 时间戳取通话开始时刻：临时气泡活不过几秒，用恒定值避免每帧变化带来的无谓重渲染。
  const timestamp = input.startedAt ?? Date.now();
  const nodes: TraceNode[] = [];
  if (hasUser) {
    nodes.push({
      id: VOICE_PARTIAL_USER_NODE_ID,
      type: 'user',
      content: input.user,
      timestamp,
      // 与落库后的真消息同款来源标记，交接时不会有徽标闪现/消失
      metadata: { source: 'voice' },
    });
  }
  if (hasAssistant) {
    nodes.push({
      id: VOICE_PARTIAL_ASSISTANT_NODE_ID,
      type: 'assistant_text',
      content: input.assistant,
      timestamp,
      metadata: { source: 'voice' },
    });
  }

  const turn: TraceTurn = {
    turnNumber: projection.turns.length + 1,
    turnId: VOICE_PARTIAL_TURN_ID,
    nodes,
    status: 'streaming',
    startTime: timestamp,
  };
  const turns = [...projection.turns, turn];
  return {
    ...projection,
    turns,
    // 没有别的轮在流式时才把吸底跟随交给通话轮——正在跑的 run 的输出跟随优先，
    // 别抢它的滚动驱动（单一吸底驱动，批 F 的 F3 结论）。
    activeTurnIndex: projection.activeTurnIndex >= 0 ? projection.activeTurnIndex : turns.length - 1,
  };
}

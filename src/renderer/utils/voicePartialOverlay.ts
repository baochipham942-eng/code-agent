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
 */
export function resolvePartialRelease(
  settled: { user?: string; assistant?: string },
  current: { user: string; assistant: string },
): { partialUser?: string; partialAssistant?: string } {
  const patch: { partialUser?: string; partialAssistant?: string } = {};
  if (settled.user !== undefined && current.user === settled.user) patch.partialUser = '';
  if (settled.assistant !== undefined && current.assistant === settled.assistant) patch.partialAssistant = '';
  return patch;
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

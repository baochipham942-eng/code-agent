// ============================================================================
// 打断判定的「证据层」（三层判定链的 L2，设计单 2026-08-14-L7-三层打断判定链）
//
// 职责只有一个：回答「这段人声是不是冲着助手来的」，**不做判决**。
// L1（上游 server_vad）答「有没有人声」，L3（voiceTurnTaking）答「说完没有、要不要回应」。
//
// 现在处于 shadow mode：本模块的输出只进日志与遥测，**不接进 decideVoiceInterrupt**。
// 目的是先拿到「开电视」与「正常对话」两组真实分布，阈值从数据里读出来再接线——
// 直接拍阈值改行为的代价是：真打断被放过时用户体感是「它听不见我说话」，比误打断更糟。
// ============================================================================

import {
  VOICE_INTERRUPT_BURST_MIN_COUNT,
  VOICE_INTERRUPT_BURST_WINDOW_MS,
  VOICE_INTERRUPT_EARLY_OVERLAP_MS,
  VOICE_INTERRUPT_SUBSTANTIVE_SPEECH_MS,
} from '../../../shared/constants/voice';

export interface VoiceInterruptEvidenceInput {
  /** 本次候选的 speech_started 时刻 */
  startedAt: number;
  /** 本次语音时长（上游 speech_stopped 带回）；缺席 = 上游没给 */
  durationMs?: number;
  /** 判定时助手是否在播报 */
  assistantPlaying: boolean;
  /** 打断发生时助手已播了多久（renderer 上报）；缺席 = 拿不到 */
  playedMs?: number;
  /** 同一通话内**此前**各候选的 speech_started 时刻（不含本次） */
  priorStartedAt: readonly number[];
  /** final 字幕；partial 阶段传空串 */
  text: string;
}

export interface VoiceInterruptEvidence {
  /** 短窗内触发次数（含本次） */
  burstCount: number;
  /** 距上一次触发的间隔；本通话首次 = undefined */
  sinceLastMs?: number;
  /** 触发密集，像持续存在的背景人声而不是偶尔开口的人 */
  burstLike: boolean;
  /** 助手刚开口就被打断；助手没在播报时 = undefined（这一维不适用） */
  earlyOverlap?: boolean;
  /** 语音长到像一句真话，而不是一声杂音 */
  substantive?: boolean;
  /** 字幕里有冲着助手来的标记（第二人称 / 祈使 / 疑问） */
  addressed: boolean;
  /** 综合档位。**临时口径**：真实分布拿到之前，这里的权重是占位的，不要当结论用 */
  tier: 'weak' | 'medium' | 'strong';
  /** 打分明细，落遥测用——调阈值时要能看出是哪一维在起作用 */
  score: number;
}

/**
 * 「这句话是冲着我说的吗」的正向标记。
 *
 * 注意方向：这是**加分项**，不是拒绝清单。枚举漏了只会让证据变弱（趋向保守、不打断），
 * 不会造成放行——这和「按名字枚举的拒绝清单」那类漏洞在结构上是相反的。
 */
const ADDRESSED_MARKERS = [
  /[你您]/,
  /[吗呢吧]\s*[?？]?$/,
  /[?？]$/,
  /^(?:帮|请|给我|麻烦|告诉我|查一下|看一下|打开|关掉|继续|重说|再说)/,
  /\b(?:you|your|please|can you|could you|tell me|help me)\b/i,
];

function isAddressed(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return ADDRESSED_MARKERS.some((pattern) => pattern.test(value));
}

/**
 * 纯函数，无副作用、不读配置——这样 shadow mode 的采样和将来的真判定吃的是同一段逻辑，
 * 不会出现「量的是一套、判的是另一套」。
 */
export function collectVoiceInterruptEvidence(
  input: VoiceInterruptEvidenceInput,
): VoiceInterruptEvidence {
  const windowStart = input.startedAt - VOICE_INTERRUPT_BURST_WINDOW_MS;
  const inWindow = input.priorStartedAt.filter(
    (at) => at > windowStart && at <= input.startedAt,
  );
  const burstCount = inWindow.length + 1;
  const lastAt = input.priorStartedAt.length
    ? Math.max(...input.priorStartedAt)
    : undefined;
  const sinceLastMs = lastAt === undefined ? undefined : input.startedAt - lastAt;
  const burstLike = burstCount >= VOICE_INTERRUPT_BURST_MIN_COUNT;

  // 助手没播报时「重叠」这一维不适用——不是「没有重叠」，是这道题不存在。
  const earlyOverlap = input.assistantPlaying && input.playedMs !== undefined
    ? input.playedMs < VOICE_INTERRUPT_EARLY_OVERLAP_MS
    : undefined;

  const substantive = input.durationMs === undefined
    ? undefined
    : input.durationMs >= VOICE_INTERRUPT_SUBSTANTIVE_SPEECH_MS;

  const addressed = isAddressed(input.text);

  let score = 0;
  if (addressed) score += 2;
  if (burstLike) score -= 2;
  if (earlyOverlap === true) score -= 1;
  if (substantive === true) score += 1;

  const tier: VoiceInterruptEvidence['tier'] = score >= 2
    ? 'strong'
    : score <= -2
      ? 'weak'
      : 'medium';

  return {
    burstCount,
    ...(sinceLastMs === undefined ? {} : { sinceLastMs }),
    burstLike,
    ...(earlyOverlap === undefined ? {} : { earlyOverlap }),
    ...(substantive === undefined ? {} : { substantive }),
    addressed,
    tier,
    score,
  };
}

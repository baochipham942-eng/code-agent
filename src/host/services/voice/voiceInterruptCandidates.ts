// ============================================================================
// 打断候选的存储形状与解析
//
// 从 voiceSessionService 抽出来的原因有两条，缺一条都不该动它：
//  1. 它只吃 interruption 这一小块状态，却被写成吃整个 ActiveSession——解析候选
//     根本不需要知道 WS、上游 handle、播报队列长什么样。
//  2. voiceSessionService 的有效行数已经顶在 god-file 门的天花板（main 上正好 1000/1000），
//     任何新功能都进不去。把本来就该独立的一块搬出来，比把新功能压成一行诚实。
// ============================================================================

import type { VoiceInterruptClassification } from '../../../shared/contract/voice';

export interface VoiceInterruptCandidate {
  itemId?: string;
  startedAt: number;
  durationMs?: number;
  assistantPlaying?: boolean;
  /** 打断发生时助手已播了多久（renderer 上报）。证据层的「早重叠」维吃它。 */
  playedMs?: number;
  classification?: VoiceInterruptClassification;
  classificationSource?: 'empty-text-fallback' | 'transcript';
  emptyTextFallbackObserved?: boolean;
  decided: boolean;
  cancelledResponseId?: string;
  responseRequested: boolean;
  finalGraceTimer?: NodeJS.Timeout;
}

/** 一通电话内的打断候选池。currentCandidateId 是「最近一次 speech_started」。 */
export interface VoiceInterruptCandidateStore {
  currentCandidateId: string | null;
  candidates: Map<string, VoiceInterruptCandidate>;
}

export interface ResolvedVoiceInterruptCandidate {
  candidateId: string;
  candidate: VoiceInterruptCandidate;
}

/**
 * **严格**按 itemId 找，找不到就是 undefined——绝不回落到「当前候选」。
 *
 * 与 resolveInterruptCandidate 的区别不是写法而是语义：那个是「尽力找一个能用的候选」，
 * 这个是「就要这一条，没有就是没有」。字幕抑制那类按分类结果做决定的地方必须用这个，
 * 回落过去会拿到别的候选的分类，把不该抑制的片段抑制掉。
 */
export function findVoiceInterruptCandidateByItemId(
  store: VoiceInterruptCandidateStore,
  itemId?: string,
): ResolvedVoiceInterruptCandidate | undefined {
  if (!itemId) return undefined;
  for (const [candidateId, candidate] of store.candidates) {
    if (candidate.itemId === itemId) return { candidateId, candidate };
  }
  return undefined;
}

/**
 * itemId 优先于 candidateId 优先于「当前候选」。
 *
 * 顺序不能反：itemId 是上游给的硬绑定，而「当前候选」只是最近一次 speech_started——
 * 用户连说两句时，晚到的字幕属于前一句，落到「当前」就会把判定记在错误的候选上。
 */
export function resolveInterruptCandidate(
  store: VoiceInterruptCandidateStore,
  identity: { candidateId?: string; itemId?: string } = {},
): ResolvedVoiceInterruptCandidate | undefined {
  const byItemId = findVoiceInterruptCandidateByItemId(store, identity.itemId);
  if (byItemId) return byItemId;
  const candidateId = identity.candidateId ?? store.currentCandidateId;
  if (!candidateId) return undefined;
  const candidate = store.candidates.get(candidateId);
  return candidate ? { candidateId, candidate } : undefined;
}

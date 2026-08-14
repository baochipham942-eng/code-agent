// ============================================================================
// 通话内说话人身份跟踪（N-L7-SPK）
//
// 两个用途（工单 §4.1），一个状态机：
//   用途一：通话内锚定——首位说话人锚为主说话人；播报期间与活跃集不匹配的
//           人声不触发打断（治电视误触发）。
//   用途二：跨会话认本人——已注册 owner 向量过阈 → 认出本人，挂个性化上下文。
//
// 合规形状（§4.3 临时锚定不落盘不建档）：本文件的一切状态只活在内存里，
// 通话 teardown 即丢——环形 PCM 缓冲、活跃说话人集、逐候选 verdict 全部如此。
// 唯一的持久写发生在 voiceprintStore（且只有用户显式注册 / 认出本人回写时间戳两条）。
//
// 判定纪律：verdict 三值 match / mismatch / unknown，只有 mismatch 改变行为，
// 且只往「少打断」方向改；一切不确定（模型缺失、片段过短、推理未完成、低能量）
// 都归 unknown = fail-open 回现状。显式打断词不经过这里（用户救援词永远有效）。
// ============================================================================

import {
  VOICEPRINT_MATCH_THRESHOLD,
  VOICEPRINT_MAX_SEGMENT_MS,
  VOICEPRINT_MIN_SEGMENT_MS,
  VOICEPRINT_OWNER_THRESHOLD,
  VOICEPRINT_RING_BUFFER_MS,
  VOICEPRINT_SEGMENT_PREFIX_MS,
} from '../../../shared/constants/voice';
import { cosineSimilarity, pcm16ToFloat32 } from './speakerFbank';
import { createLogger } from '../infra/logger';

const logger = createLogger('SpeakerIdentity');

const SAMPLE_RATE = 16_000;
/** 活跃集上限：一通电话里真实参与对话的人数不会超过这个数。 */
const ACTIVE_SET_CAP = 8;
/** 低于该 RMS 的片段当静音处理（切窗对错了/纯底噪），不做判定。 */
const MIN_SEGMENT_RMS = 0.004;

export type SpeakerVerdict = 'match' | 'mismatch' | 'unknown';

export interface SpeakerIdentityTracker {
  /** 上行 16k PCM16 mono 帧进环形缓冲。 */
  feed(frame: Buffer, now?: number): void;
  /** speech_stopped 时切片并异步算 embedding；返回的 promise 只供测试等待。 */
  onSpeechStopped(candidateId: string, durationMs: number, now?: number): Promise<void>;
  /** 打断判定读这一句。推理没完成 = unknown（不阻塞判定路径）。 */
  verdictFor(candidateId: string): SpeakerVerdict;
  /** no_playback 轮 final：这个人真的在对话，纳入活跃集（当场生效，不设观察期）。 */
  admitCandidate(candidateId: string): void;
  /** 是否已认出本人（一通只升不降）。 */
  isOwnerRecognized(): boolean;
  /** 显式注册用：取主说话人聚类的样本（≤count 条，最新优先）。 */
  collectOwnerSamples(count: number): Float32Array[];
}

export interface SpeakerIdentityOptions {
  /** voiceprintStore.loadOwnerEmbeddings() 的结果；空数组 = 未注册（默认态）。 */
  ownerEmbeddings: Float32Array[];
  /** speakerEmbedding.embedPcm；模型不可用时返回 null。 */
  embed(pcm: Float32Array): Promise<Float32Array | null>;
  /** 首次认出本人时回调（挂个性化上下文 + 回写 lastMatchedAt 在调用方做）。 */
  onOwnerRecognized?: () => void;
}

export function createSpeakerIdentityTracker(opts: SpeakerIdentityOptions): SpeakerIdentityTracker {
  const ringSamples = (VOICEPRINT_RING_BUFFER_MS / 1_000) * SAMPLE_RATE;
  const ring = new Float32Array(ringSamples);
  let totalWritten = 0; // 累计写入样本数（无回绕）
  let lastWriteAt = 0; // 最新样本对应的墙钟

  const activeSet: Float32Array[] = [];
  const candidates = new Map<string, { verdict: SpeakerVerdict; embedding: Float32Array | null; ownerHit: boolean }>();
  /** 主说话人聚类的样本（锚 + 后续 match 的段），显式注册时从这里取。 */
  const anchorSamples: Float32Array[] = [];
  let ownerRecognized = false;

  function writeSamples(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) ring[(totalWritten + i) % ringSamples] = samples[i];
    totalWritten += samples.length;
  }

  /** 按墙钟切 [from, to]。超出缓冲范围的部分自动截掉。 */
  function slice(fromMs: number, toMs: number): Float32Array {
    const endSample = totalWritten - Math.round(((lastWriteAt - toMs) * SAMPLE_RATE) / 1_000);
    const startSample = totalWritten - Math.round(((lastWriteAt - fromMs) * SAMPLE_RATE) / 1_000);
    const lo = Math.max(0, totalWritten - ringSamples, startSample);
    const hi = Math.min(totalWritten, Math.max(lo, endSample));
    const out = new Float32Array(hi - lo);
    for (let i = lo; i < hi; i++) out[i - lo] = ring[i % ringSamples];
    return out;
  }

  function rms(pcm: Float32Array): number {
    let s = 0;
    for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
    return pcm.length ? Math.sqrt(s / pcm.length) : 0;
  }

  function maxSim(embedding: Float32Array, refs: Float32Array[]): number {
    let best = -1;
    for (const ref of refs) best = Math.max(best, cosineSimilarity(embedding, ref));
    return best;
  }

  function recognizeOwnerIfHit(ownerSim: number): void {
    if (ownerRecognized || ownerSim < VOICEPRINT_OWNER_THRESHOLD) return;
    ownerRecognized = true;
    logger.info('voiceprint owner recognized');
    opts.onOwnerRecognized?.();
  }

  return {
    feed(frame, now = Date.now()) {
      writeSamples(pcm16ToFloat32(frame));
      lastWriteAt = now;
    },

    async onSpeechStopped(candidateId, durationMs, now = Date.now()) {
      const entry = { verdict: 'unknown' as SpeakerVerdict, embedding: null as Float32Array | null, ownerHit: false };
      candidates.set(candidateId, entry);
      if (durationMs < VOICEPRINT_MIN_SEGMENT_MS) return;
      const from = now - Math.min(durationMs, VOICEPRINT_MAX_SEGMENT_MS) - VOICEPRINT_SEGMENT_PREFIX_MS;
      const segment = slice(from, now);
      if (segment.length < (VOICEPRINT_MIN_SEGMENT_MS / 1_000) * SAMPLE_RATE) return;
      if (rms(segment) < MIN_SEGMENT_RMS) return;
      let embedding: Float32Array | null = null;
      try {
        embedding = await opts.embed(segment);
      } catch (error) {
        logger.warn('voiceprint embed failed', { message: error instanceof Error ? error.message : 'unknown' });
      }
      if (!embedding) return;
      entry.embedding = embedding;

      const ownerSim = opts.ownerEmbeddings.length ? maxSim(embedding, opts.ownerEmbeddings) : -1;
      entry.ownerHit = ownerSim >= VOICEPRINT_OWNER_THRESHOLD;
      recognizeOwnerIfHit(ownerSim);

      const refs = [...activeSet, ...opts.ownerEmbeddings];
      if (!refs.length) {
        // 本通话首位说话人：直接锚为主说话人（工单 §4.1 读图重点）
        activeSet.push(embedding);
        anchorSamples.push(embedding);
        entry.verdict = 'match';
        logger.info('voiceprint anchored first speaker', { candidateId });
        return;
      }
      const sim = maxSim(embedding, refs);
      entry.verdict = sim >= VOICEPRINT_MATCH_THRESHOLD ? 'match' : 'mismatch';
      if (entry.verdict === 'match') {
        anchorSamples.push(embedding);
        if (anchorSamples.length > 8) anchorSamples.shift();
      }
      // 只记档位不记内容；相似度取整到 0.01 足够判因，不构成内容泄漏。
      logger.info('voiceprint verdict', {
        candidateId,
        verdict: entry.verdict,
        sim: Math.round(sim * 100) / 100,
        ownerHit: entry.ownerHit,
        activeSetSize: activeSet.length,
      });
    },

    verdictFor(candidateId) {
      return candidates.get(candidateId)?.verdict ?? 'unknown';
    },

    admitCandidate(candidateId) {
      const entry = candidates.get(candidateId);
      if (!entry?.embedding || entry.verdict !== 'mismatch') return;
      if (activeSet.length >= ACTIVE_SET_CAP) return;
      activeSet.push(entry.embedding);
      entry.verdict = 'match';
      logger.info('voiceprint speaker admitted to active set', { candidateId, activeSetSize: activeSet.length });
    },

    isOwnerRecognized() {
      return ownerRecognized;
    },

    collectOwnerSamples(count) {
      return anchorSamples.slice(-count);
    },
  };
}

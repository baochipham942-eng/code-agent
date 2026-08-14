import { describe, expect, it, vi } from 'vitest';
import { VOICEPRINT_EMBEDDING_DIM } from '../../src/shared/constants/voice';
import { createSpeakerIdentityTracker } from '../../src/host/services/voice/speakerIdentity';

// 两个可分的「说话人指纹」：正交向量，cosine=0；同人重复 = 同向量，cosine=1。
function fp(axis: number): Float32Array {
  const v = new Float32Array(VOICEPRINT_EMBEDDING_DIM);
  v[axis] = 1;
  return v;
}

/** 有声帧：足够响的伪 PCM16（1 秒 = 32000 字节）。 */
function loudFrame(seconds: number): Buffer {
  const buf = Buffer.alloc(Math.round(seconds * 16_000) * 2);
  for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(((i % 50) - 25) * 800, i * 2);
  return buf;
}

interface Turn {
  candidateId: string;
  speaker: Float32Array;
  durationMs?: number;
}

/** 喂一轮语音：先进帧再报 speech_stopped。embed mock 按「该轮属于谁」返回指纹。 */
function makeHarness(opts: { owner?: Float32Array[]; onOwnerRecognized?: () => void } = {}) {
  const plan = new Map<string, Float32Array>();
  const embed = vi.fn(async () => fp(0));
  const tracker = createSpeakerIdentityTracker({
    ownerEmbeddings: opts.owner ?? [],
    embed,
    ...(opts.onOwnerRecognized ? { onOwnerRecognized: opts.onOwnerRecognized } : {}),
  });
  let clock = 1_000_000;
  async function speak(turn: Turn): Promise<void> {
    const durationMs = turn.durationMs ?? 2_000;
    plan.set(turn.candidateId, turn.speaker);
    embed.mockImplementation(async () => plan.get(turn.candidateId) ?? null);
    clock += durationMs;
    tracker.feed(loudFrame(durationMs / 1_000), clock);
    await tracker.onSpeechStopped(turn.candidateId, durationMs, clock);
  }
  return { tracker, speak, embed };
}

describe('speakerIdentity', () => {
  it('首位说话人直接锚为主说话人，verdict=match', async () => {
    const { tracker, speak } = makeHarness();
    await speak({ candidateId: 'c1', speaker: fp(0) });
    expect(tracker.verdictFor('c1')).toBe('match');
  });

  it('电视人声（与锚不匹配的新声纹）→ mismatch；主用户再开口仍 match（判据3 正负成对）', async () => {
    const { tracker, speak } = makeHarness();
    await speak({ candidateId: 'user1', speaker: fp(0) });
    await speak({ candidateId: 'tv1', speaker: fp(1) });
    await speak({ candidateId: 'user2', speaker: fp(0) });
    expect(tracker.verdictFor('tv1')).toBe('mismatch');
    expect(tracker.verdictFor('user2')).toBe('match');
  });

  it('admitCandidate：真加入对话的人当场进活跃集，后续同人 match（判据4 机制）', async () => {
    const { tracker, speak } = makeHarness();
    await speak({ candidateId: 'user1', speaker: fp(0) });
    await speak({ candidateId: 'guest1', speaker: fp(1) });
    expect(tracker.verdictFor('guest1')).toBe('mismatch');
    tracker.admitCandidate('guest1'); // no_playback final：她在接话
    await speak({ candidateId: 'guest2', speaker: fp(1) });
    expect(tracker.verdictFor('guest2')).toBe('match');
  });

  it('片段过短 → unknown（fail-open，不许拿去改行为）', async () => {
    const { tracker, speak, embed } = makeHarness();
    await speak({ candidateId: 'short', speaker: fp(0), durationMs: 300 });
    expect(tracker.verdictFor('short')).toBe('unknown');
    expect(embed).not.toHaveBeenCalled();
  });

  it('模型不可用（embed 返回 null）→ unknown', async () => {
    const tracker = createSpeakerIdentityTracker({ ownerEmbeddings: [], embed: async () => null });
    tracker.feed(loudFrame(2), 1_002_000);
    await tracker.onSpeechStopped('c1', 2_000, 1_002_000);
    expect(tracker.verdictFor('c1')).toBe('unknown');
  });

  it('没见过的 candidateId → unknown（推理未完成时判定不阻塞）', () => {
    const { tracker } = makeHarness();
    expect(tracker.verdictFor('nope')).toBe('unknown');
  });

  it('静音片段（低 RMS）→ unknown，不做判定', async () => {
    const tracker = createSpeakerIdentityTracker({ ownerEmbeddings: [], embed: async () => fp(0) });
    tracker.feed(Buffer.alloc(2 * 16_000 * 2), 1_002_000); // 全零帧
    await tracker.onSpeechStopped('silent', 2_000, 1_002_000);
    expect(tracker.verdictFor('silent')).toBe('unknown');
  });

  it('已注册 owner 开口 → 认出本人回调触发一次，且 verdict=match（判据2 机制）', async () => {
    const onOwnerRecognized = vi.fn();
    const { tracker, speak } = makeHarness({ owner: [fp(0)], onOwnerRecognized });
    await speak({ candidateId: 'c1', speaker: fp(0) });
    await speak({ candidateId: 'c2', speaker: fp(0) });
    expect(tracker.isOwnerRecognized()).toBe(true);
    expect(onOwnerRecognized).toHaveBeenCalledTimes(1);
    expect(tracker.verdictFor('c1')).toBe('match');
  });

  it('已注册但来的是别人 → 不认本人，且与 owner 不匹配 = mismatch（判据2 负例）', async () => {
    const onOwnerRecognized = vi.fn();
    const { tracker, speak } = makeHarness({ owner: [fp(0)], onOwnerRecognized });
    await speak({ candidateId: 'stranger', speaker: fp(1) });
    expect(tracker.isOwnerRecognized()).toBe(false);
    expect(onOwnerRecognized).not.toHaveBeenCalled();
    expect(tracker.verdictFor('stranger')).toBe('mismatch');
  });

  it('collectOwnerSamples 返回主说话人聚类样本，供显式注册', async () => {
    const { tracker, speak } = makeHarness();
    await speak({ candidateId: 'c1', speaker: fp(0) });
    await speak({ candidateId: 'c2', speaker: fp(0) });
    const samples = tracker.collectOwnerSamples(3);
    expect(samples.length).toBe(2);
    expect(samples[0][0]).toBe(1);
  });
});

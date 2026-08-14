import { describe, expect, it } from 'vitest';
import { collectVoiceInterruptEvidence } from '../../src/host/services/voice/voiceInterruptEvidence';
import {
  VOICE_INTERRUPT_BURST_MIN_COUNT,
  VOICE_INTERRUPT_BURST_WINDOW_MS,
} from '../../src/shared/constants/voice';

const T0 = 1_700_000_000_000;

describe('打断证据层（L2）', () => {
  it('电视形态：窗内密集触发 + 与播报起点无关 + 无指向性 → 证据弱', () => {
    // 真机症状是 18 秒 4 次；这里按同一节奏铺前三次，本次是第四次。
    const evidence = collectVoiceInterruptEvidence({
      startedAt: T0 + 18_000,
      durationMs: 1_500,
      assistantPlaying: true,
      playedMs: 300,
      priorStartedAt: [T0, T0 + 4_500, T0 + 9_000, T0 + 13_500],
      text: '明天上海天气不错',
    });

    expect(evidence.burstLike).toBe(true);
    expect(evidence.addressed).toBe(false);
    expect(evidence.earlyOverlap).toBe(true);
    expect(evidence.tier).toBe('weak');
  });

  it('真人打断形态：稀疏 + 播报中段 + 指向性文本 → 证据强', () => {
    const evidence = collectVoiceInterruptEvidence({
      startedAt: T0 + 120_000,
      durationMs: 1_800,
      assistantPlaying: true,
      playedMs: 6_000,
      priorStartedAt: [T0],
      text: '你能不能帮我查一下明天的天气',
    });

    expect(evidence.burstLike).toBe(false);
    expect(evidence.addressed).toBe(true);
    expect(evidence.earlyOverlap).toBe(false);
    expect(evidence.tier).toBe('strong');
  });

  it('窗外的历史触发不计入密集度——否则一通长电话必然误判成电视', () => {
    const stale = Array.from(
      { length: 10 },
      (_, i) => T0 + i * 1_000,
    );
    const evidence = collectVoiceInterruptEvidence({
      startedAt: T0 + VOICE_INTERRUPT_BURST_WINDOW_MS + 60_000,
      assistantPlaying: false,
      priorStartedAt: stale,
      text: '你好',
    });

    expect(evidence.burstCount).toBe(1);
    expect(evidence.burstLike).toBe(false);
  });

  it('密集度判定含本次：窗内已有 N-1 次时本次即达阈值', () => {
    const prior = Array.from(
      { length: VOICE_INTERRUPT_BURST_MIN_COUNT - 1 },
      (_, i) => T0 + i * 1_000,
    );
    const evidence = collectVoiceInterruptEvidence({
      startedAt: T0 + 5_000,
      assistantPlaying: false,
      priorStartedAt: prior,
      text: '',
    });

    expect(evidence.burstCount).toBe(VOICE_INTERRUPT_BURST_MIN_COUNT);
    expect(evidence.burstLike).toBe(true);
  });

  it('助手没在播报时「早重叠」这一维不适用——是缺席，不是 false', () => {
    const evidence = collectVoiceInterruptEvidence({
      startedAt: T0,
      assistantPlaying: false,
      playedMs: 0,
      priorStartedAt: [],
      text: '你好',
    });

    expect(evidence.earlyOverlap).toBeUndefined();
  });

  it('上游没给 durationMs 时 substantive 缺席，不当成 false 扣分', () => {
    const withDuration = collectVoiceInterruptEvidence({
      startedAt: T0,
      durationMs: 2_000,
      assistantPlaying: false,
      priorStartedAt: [],
      text: '随便说点什么',
    });
    const without = collectVoiceInterruptEvidence({
      startedAt: T0,
      assistantPlaying: false,
      priorStartedAt: [],
      text: '随便说点什么',
    });

    expect(withDuration.substantive).toBe(true);
    expect(without.substantive).toBeUndefined();
    // 缺席只是拿不到这一维的加分，不该变成扣分
    expect(without.score).toBe(withDuration.score - 1);
  });

  it('本通话首次触发没有 sinceLastMs', () => {
    const evidence = collectVoiceInterruptEvidence({
      startedAt: T0,
      assistantPlaying: false,
      priorStartedAt: [],
      text: '',
    });

    expect(evidence.sinceLastMs).toBeUndefined();
    expect(evidence.burstCount).toBe(1);
  });

  it('指向性是加分项而非拒绝清单：认不出的句子只是拿不到加分，不会被判成强证据', () => {
    const unknown = collectVoiceInterruptEvidence({
      startedAt: T0,
      durationMs: 2_000,
      assistantPlaying: true,
      playedMs: 8_000,
      priorStartedAt: [],
      text: '天线宝宝说再见啦',
    });

    expect(unknown.addressed).toBe(false);
    expect(unknown.tier).not.toBe('strong');
  });
});

// 证据层走**真实路径**断言：生产里没人调纯函数，调的是 sampleVoiceInterruptEvidence，
// 而它的产物就是落进遥测的那条记录——shadow mode 要量的正是这个。
// 所以这里断言遥测收到了什么，而不是给纯函数开一个只为测试存在的 export。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const telemetry = vi.hoisted(() => ({ recordVoiceInterruptEvidence: vi.fn() }));
vi.mock('../../src/host/services/voice/voiceTelemetry', () => telemetry);
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { sampleVoiceInterruptEvidence } = await import(
  '../../src/host/services/voice/voiceInterruptEvidence'
);
const {
  VOICE_INTERRUPT_BURST_MIN_COUNT,
  VOICE_INTERRUPT_BURST_WINDOW_MS,
} = await import('../../src/shared/constants/voice');

const T0 = 1_700_000_000_000;

/** 采一次并取遥测收到的那条记录。 */
function sample(overrides: Partial<Parameters<typeof sampleVoiceInterruptEvidence>[0]>) {
  telemetry.recordVoiceInterruptEvidence.mockClear();
  sampleVoiceInterruptEvidence({
    provider: 'dashscope-qwen-omni',
    voiceSessionId: 'vs-1',
    candidateId: 'c-1',
    startedAt: T0,
    assistantPlaying: false,
    priorStartedAt: [],
    text: '',
    decidedClassification: 'true_interrupt',
    decidedCancel: true,
    ...overrides,
  });
  expect(telemetry.recordVoiceInterruptEvidence).toHaveBeenCalledTimes(1);
  return telemetry.recordVoiceInterruptEvidence.mock.calls[0][0] as Record<string, unknown>;
}

describe('打断证据层（L2）· 经采样出口的真实路径', () => {
  beforeEach(() => vi.clearAllMocks());

  it('电视形态：窗内密集触发 + 与播报起点无关 + 无指向性 → 证据弱', () => {
    // 真机症状是 18 秒 4 次；前四次铺在窗内，本次是第五次。
    const r = sample({
      startedAt: T0 + 18_000,
      durationMs: 1_500,
      assistantPlaying: true,
      playedMs: 300,
      priorStartedAt: [T0, T0 + 4_500, T0 + 9_000, T0 + 13_500],
      text: '明天上海多云转晴，气温十八到二十五度',
    });

    expect(r.burstLike).toBe(true);
    expect(r.addressed).toBe(false);
    expect(r.earlyOverlap).toBe(true);
    expect(r.tier).toBe('weak');
  });

  it('真人打断形态：稀疏 + 播报中段 + 指向性文本 → 证据强', () => {
    const r = sample({
      startedAt: T0 + 120_000,
      durationMs: 1_800,
      assistantPlaying: true,
      playedMs: 6_000,
      priorStartedAt: [T0],
      text: '你能不能帮我查一下明天的天气',
    });

    expect(r.burstLike).toBe(false);
    expect(r.addressed).toBe(true);
    expect(r.earlyOverlap).toBe(false);
    expect(r.tier).toBe('strong');
  });

  it('窗外的历史触发不计入密集度——否则一通长电话必然被误判成电视', () => {
    const r = sample({
      startedAt: T0 + VOICE_INTERRUPT_BURST_WINDOW_MS + 60_000,
      priorStartedAt: Array.from({ length: 10 }, (_, i) => T0 + i * 1_000),
      text: '你好',
    });

    expect(r.burstCount).toBe(1);
    expect(r.burstLike).toBe(false);
  });

  it('密集度含本次：窗内已有 N-1 次时本次即达阈值', () => {
    const r = sample({
      startedAt: T0 + 5_000,
      priorStartedAt: Array.from(
        { length: VOICE_INTERRUPT_BURST_MIN_COUNT - 1 },
        (_, i) => T0 + i * 1_000,
      ),
    });

    expect(r.burstCount).toBe(VOICE_INTERRUPT_BURST_MIN_COUNT);
    expect(r.burstLike).toBe(true);
  });

  it('助手没在播报时「早重叠」不适用——是字段缺席，不是 false', () => {
    const r = sample({ assistantPlaying: false, playedMs: 0, text: '你好' });
    expect('earlyOverlap' in r).toBe(false);
  });

  it('上游没给 durationMs 时 substantive 缺席，不当成 false 扣分', () => {
    const withDuration = sample({ durationMs: 2_000, text: '随便说点什么' });
    const without = sample({ text: '随便说点什么' });

    expect(withDuration.substantive).toBe(true);
    expect('substantive' in without).toBe(false);
    // 缺席只是拿不到这一维的加分，不该变成扣分
    expect(without.score).toBe((withDuration.score as number) - 1);
  });

  it('本通话首次触发没有 sinceLastMs', () => {
    const r = sample({});
    expect('sinceLastMs' in r).toBe(false);
    expect(r.burstCount).toBe(1);
  });

  it('指向性是加分项不是拒绝清单：认不出的句子只是拿不到加分，不会被判成强证据', () => {
    const r = sample({
      durationMs: 2_000,
      assistantPlaying: true,
      playedMs: 8_000,
      text: '天线宝宝说再见啦',
    });

    expect(r.addressed).toBe(false);
    expect(r.tier).not.toBe('strong');
  });

  it('L3 的真实结论一并落进遥测——「证据说弱、L3 却判真打断」的分歧量得出来', () => {
    const r = sample({
      priorStartedAt: [T0 - 3_000, T0 - 6_000],
      text: '那家店确实火',
      decidedClassification: 'true_interrupt',
      decidedCancel: true,
    });

    expect(r.tier).toBe('weak');
    expect(r.decidedClassification).toBe('true_interrupt');
    expect(r.decidedCancel).toBe(true);
  });
});

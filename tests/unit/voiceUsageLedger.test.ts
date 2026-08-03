// 通话时长记账（批 H · 方案 §5.4 的 voice_minutes 一侧）。
// 只钉纯函数 accumulate：跨月分桶、累积、零时长不记。
// 落盘那半边是既有偏好 KV 的 best-effort 写入，没有独立逻辑可钉。

import { describe, expect, it } from 'vitest';
import type { VoiceTokenUsage } from '../../src/shared/contract/voice';
import {
  accumulate,
  accumulateFailure,
  monthKey,
  summarize,
  type VoiceUsageBuckets,
} from '../../src/host/services/voice/voiceUsageLedger';

const JULY = new Date(2026, 6, 27, 10, 0, 0).getTime();
const AUGUST = new Date(2026, 7, 2, 10, 0, 0).getTime();
const FIRST_USAGE: VoiceTokenUsage = {
  totalTokens: 100,
  inputTokens: 70,
  outputTokens: 30,
  inputAudioTokens: 20,
  inputTextTokens: 50,
  outputAudioTokens: 25,
  outputTextTokens: 5,
};

describe('通话时长记账', () => {
  it('首次通话开出当月的桶', () => {
    expect(accumulate({}, JULY, 75)).toEqual({
      [monthKey(JULY)]: { seconds: 75, calls: 1, failedAttempts: 0 },
    });
  });

  it('同月累加时长与通话数', () => {
    const first = accumulate({}, JULY, 75);
    expect(accumulate(first, JULY, 25)).toEqual({
      [monthKey(JULY)]: { seconds: 100, calls: 2, failedAttempts: 0 },
    });
  });

  it('同月 token 与 seconds/calls 并存并逐维累加', () => {
    const first = accumulate({}, JULY, 75, FIRST_USAGE);
    const second = accumulate(first, JULY, 25, {
      totalTokens: 40,
      inputTokens: 30,
      outputTokens: 10,
      inputAudioTokens: 10,
      inputTextTokens: 20,
      outputAudioTokens: 8,
      outputTextTokens: 2,
    });
    expect(second[monthKey(JULY)]).toEqual({
      seconds: 100,
      calls: 2,
      failedAttempts: 0,
      tokens: {
        totalTokens: 140,
        inputTokens: 100,
        outputTokens: 40,
        inputAudioTokens: 30,
        inputTextTokens: 70,
        outputAudioTokens: 33,
        outputTextTokens: 7,
      },
    });
  });

  it('跨月另起一桶，旧月不动（「本月用量」才有意义）', () => {
    const buckets: VoiceUsageBuckets = accumulate(accumulate({}, JULY, 75), AUGUST, 30);
    expect(buckets[monthKey(JULY)]).toEqual({ seconds: 75, calls: 1, failedAttempts: 0 });
    expect(buckets[monthKey(AUGUST)]).toEqual({ seconds: 30, calls: 1, failedAttempts: 0 });
  });

  it('零时长不记（建连即挂不该算一通）', () => {
    const buckets = accumulate({}, JULY, 75);
    expect(accumulate(buckets, JULY, 0)).toBe(buckets);
  });

  it('成功通话只增加 calls，failedAttempts 不变', () => {
    const before: VoiceUsageBuckets = {
      [monthKey(JULY)]: { seconds: 20, calls: 1, failedAttempts: 2 },
    };
    expect(accumulate(before, JULY, 10)[monthKey(JULY)]).toEqual({
      seconds: 30,
      calls: 2,
      failedAttempts: 2,
    });
  });

  it('失败尝试只增加 failedAttempts，seconds 与 calls 不变', () => {
    const before: VoiceUsageBuckets = {
      [monthKey(JULY)]: { seconds: 20, calls: 1, failedAttempts: 2 },
    };
    expect(accumulateFailure(before, JULY)[monthKey(JULY)]).toEqual({
      seconds: 20,
      calls: 1,
      failedAttempts: 3,
    });
  });

  it('存量桶缺少 failedAttempts 时按 0 读取且累加不产生 NaN', () => {
    const legacy: VoiceUsageBuckets = { [monthKey(JULY)]: { seconds: 20, calls: 1 } };
    expect(summarize(legacy, JULY)).toEqual({
      monthSeconds: 20,
      monthCalls: 1,
      monthFailedAttempts: 0,
    });
    expect(accumulateFailure(legacy, JULY)[monthKey(JULY)].failedAttempts).toBe(1);
  });

  it('存量桶只有 seconds/calls 时 token 保持缺失，原字段不丢', () => {
    const legacy: VoiceUsageBuckets = { [monthKey(JULY)]: { seconds: 20, calls: 1 } };
    expect(summarize(legacy, JULY)).toEqual({
      monthSeconds: 20,
      monthCalls: 1,
      monthFailedAttempts: 0,
    });
    expect(accumulate(legacy, JULY, 10)[monthKey(JULY)]).toEqual({
      seconds: 30,
      calls: 2,
      failedAttempts: 0,
    });
  });
});

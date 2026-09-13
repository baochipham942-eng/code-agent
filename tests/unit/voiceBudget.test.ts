import { afterEach, describe, expect, it, vi } from 'vitest';
import { QWEN_OMNI_REALTIME_MODEL, VOICE_BUDGET } from '../../src/shared/constants/voice';
import type { VoiceLiveSettings } from '../../src/shared/contract/settings';
import type { VoiceEvent, VoiceTokenUsage } from '../../src/shared/contract/voice';
import { estimateRealtimeVoiceCost } from '../../src/shared/pricing/estimateRealtimeVoiceCost';
import {
  startVoiceBudgetWatch,
  stopVoiceBudgetWatch,
  type VoiceBudgetSubject,
} from '../../src/host/services/voice/voiceBudget';

const TEN_MINUTES_MS = 10 * 60_000;
const SESSION_ID = 'voice-budget-unit';

const AUDIO_USAGE: VoiceTokenUsage = {
  totalTokens: 2_000,
  inputTokens: 1_000,
  outputTokens: 1_000,
  inputAudioTokens: 1_000,
  inputTextTokens: 0,
  outputAudioTokens: 1_000,
  outputTextTokens: 0,
};

afterEach(() => {
  stopVoiceBudgetWatch(SESSION_ID);
});

function runWatch(
  live: VoiceLiveSettings | undefined,
  elapsedMs: number,
  usage?: VoiceTokenUsage,
): {
  events: VoiceEvent[];
  hangup: ReturnType<typeof vi.fn>;
  budget: Extract<VoiceEvent, { type: 'budget' }> | undefined;
} {
  const events: VoiceEvent[] = [];
  const hangup = vi.fn();
  const session: VoiceBudgetSubject = {
    id: SESSION_ID,
    ending: false,
    startedAt: Date.now() - elapsedMs,
    conversationModel: QWEN_OMNI_REALTIME_MODEL,
    tokenUsage: { value: usage },
  };
  startVoiceBudgetWatch(session, live, (event) => events.push(event), hangup, () => true);
  stopVoiceBudgetWatch(session.id);
  const budget = events.filter(
    (event): event is Extract<VoiceEvent, { type: 'budget' }> => event.type === 'budget',
  ).at(-1);
  return { events, hangup, budget };
}

describe('resolveVoiceBudgetConfig', () => {
  it('未配置时两轨都不设、动作为默认仅提醒', () => {
    expect(runWatch(undefined, TEN_MINUTES_MS).budget).toBeUndefined();
    expect(runWatch({}, TEN_MINUTES_MS).budget).toBeUndefined();
    expect(runWatch({ callMinuteLimit: 5 }, 5 * 60_000).hangup).not.toHaveBeenCalled();
  });

  it('0 / 负数 / 非有限值都当成未设', () => {
    expect(runWatch({
      callMinuteLimit: 0,
      callCostLimit: -1,
    }, TEN_MINUTES_MS).budget).toBeUndefined();
    expect(runWatch({
      callMinuteLimit: Number.NaN,
      callCostLimit: Number.POSITIVE_INFINITY,
    }, TEN_MINUTES_MS).budget).toBeUndefined();
  });

  it('正数上限保留，hangup 动作原样采纳', () => {
    const hangup = runWatch({
      callMinuteLimit: 5,
      callCostLimit: 0.25,
      callCostLimitAction: 'hangup',
    }, 5 * 60_000);
    expect(hangup.budget).toMatchObject({
      level: 'blocked',
      minutesLimit: 5,
      costLimit: 0.25,
    });
    expect(hangup.events).toContainEqual({ type: 'session.ended', reason: 'budget' });
    expect(hangup.hangup).toHaveBeenCalledOnce();
    expect(runWatch({ callMinuteLimit: 5 }, 1_000).budget).toMatchObject({
      minutesLimit: 5,
      costLimit: null,
    });
  });
});

describe('evaluateVoiceBudget 档位边界', () => {
  const minuteLimit = 10;

  function atRatio(ratio: number) {
    return runWatch({ callMinuteLimit: minuteLimit }, ratio * minuteLimit * 60_000).budget;
  }

  it('未设任何上限时即使已打满硬顶窗口也是 none', () => {
    expect(runWatch({
      callCostLimit: undefined,
    }, TEN_MINUTES_MS, AUDIO_USAGE).budget).toBeUndefined();
  });

  it('占用比刚好低于静默档 → none', () => {
    expect(atRatio(0.699)?.level).toBe('none');
  });

  it('70% 进入静默档，85% 以下仍是 silent', () => {
    expect(atRatio(VOICE_BUDGET.SILENT_RATIO)?.level).toBe('silent');
    expect(atRatio(VOICE_BUDGET.WARNING_RATIO - 0.001)?.level).toBe('silent');
  });

  it('85% 进入告警档，100% 以下仍是 warning', () => {
    expect(atRatio(VOICE_BUDGET.WARNING_RATIO)?.level).toBe('warning');
    expect(atRatio(VOICE_BUDGET.BLOCK_RATIO - 0.001)?.level).toBe('warning');
  });

  it('100% 及超出都是 blocked', () => {
    expect(atRatio(VOICE_BUDGET.BLOCK_RATIO)?.level).toBe('blocked');
    expect(atRatio(1.2)?.level).toBe('blocked');
  });
});

describe('evaluateVoiceBudget 分钟 / 成本双轨', () => {
  it('只设分钟上限时成本字段保持透传但不参与档位', () => {
    const { budget } = runWatch({ callMinuteLimit: 5 }, 5 * 60_000, AUDIO_USAGE);
    expect(budget).toMatchObject({
      level: 'blocked',
      minutesUsed: 5,
      minutesLimit: 5,
      costLimit: null,
      usageRatio: 1,
    });
    expect(budget?.costAmount).toBeGreaterThan(0);
  });

  it('只设成本上限且尚无估算时不把缺失当成 0%', () => {
    const { budget } = runWatch({ callCostLimit: 1 }, 9 * 60_000);
    expect(budget).toMatchObject({
      level: 'none',
      usageRatio: 0,
      costAmount: null,
      costLimit: 1,
    });
  });

  it('只设成本上限且已有估算时按成本轨定档', () => {
    const estimate = estimateRealtimeVoiceCost(QWEN_OMNI_REALTIME_MODEL, AUDIO_USAGE);
    expect(estimate).not.toBeNull();
    const { budget } = runWatch(
      { callCostLimit: estimate!.amount / VOICE_BUDGET.WARNING_RATIO },
      1_000,
      AUDIO_USAGE,
    );
    expect(budget?.level).toBe('warning');
  });

  it('双轨同时开启时取占用比更高的那条', () => {
    const estimate = estimateRealtimeVoiceCost(QWEN_OMNI_REALTIME_MODEL, AUDIO_USAGE);
    expect(estimate).not.toBeNull();
    const { budget } = runWatch(
      {
        callMinuteLimit: 10,
        callCostLimit: estimate!.amount / 0.95,
      },
      3 * 60_000,
      AUDIO_USAGE,
    );
    expect(budget?.level).toBe('warning');
    expect(budget?.usageRatio).toBeCloseTo(0.95);
  });

  it('0 或负数上限与未设相同', () => {
    expect(runWatch({
      callMinuteLimit: 0,
      callCostLimit: -2,
    }, TEN_MINUTES_MS, AUDIO_USAGE).budget).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { VOICE_BUDGET } from '../../src/shared/constants/voice';
import {
  evaluateVoiceBudget,
  isVoiceBudgetConfigured,
  resolveVoiceBudgetConfig,
} from '../../src/host/services/voice/voiceBudget';

const TEN_MINUTES_MS = 10 * 60_000;

describe('resolveVoiceBudgetConfig', () => {
  it('未配置时两轨都不设、动作为默认仅提醒', () => {
    expect(resolveVoiceBudgetConfig(undefined)).toEqual({
      minuteLimit: null,
      costLimit: null,
      exceedAction: VOICE_BUDGET.DEFAULT_EXCEED_ACTION,
    });
    expect(isVoiceBudgetConfigured(resolveVoiceBudgetConfig({}))).toBe(false);
  });

  it('0 / 负数 / 非有限值都当成未设', () => {
    expect(resolveVoiceBudgetConfig({
      callMinuteLimit: 0,
      callCostLimit: -1,
    })).toMatchObject({ minuteLimit: null, costLimit: null });
    expect(resolveVoiceBudgetConfig({
      callMinuteLimit: Number.NaN,
      callCostLimit: Number.POSITIVE_INFINITY,
    })).toMatchObject({ minuteLimit: null, costLimit: null });
  });

  it('正数上限保留，hangup 动作原样采纳', () => {
    expect(resolveVoiceBudgetConfig({
      callMinuteLimit: 5,
      callCostLimit: 0.25,
      callCostLimitAction: 'hangup',
    })).toEqual({
      minuteLimit: 5,
      costLimit: 0.25,
      exceedAction: 'hangup',
    });
    expect(isVoiceBudgetConfigured(resolveVoiceBudgetConfig({ callMinuteLimit: 5 }))).toBe(true);
  });
});

describe('evaluateVoiceBudget 档位边界', () => {
  const minuteLimit = 10;

  function atRatio(ratio: number) {
    return evaluateVoiceBudget({
      elapsedMs: ratio * minuteLimit * 60_000,
      costAmount: null,
      minuteLimit,
      costLimit: null,
    });
  }

  it('未设任何上限时即使已打满硬顶窗口也是 none', () => {
    expect(evaluateVoiceBudget({
      elapsedMs: TEN_MINUTES_MS,
      costAmount: 9.99,
      minuteLimit: null,
      costLimit: null,
    })).toMatchObject({ level: 'none', usageRatio: 0, minutesLimit: null, costLimit: null });
  });

  it('占用比刚好低于静默档 → none', () => {
    expect(atRatio(0.699).level).toBe('none');
  });

  it('70% 进入静默档，85% 以下仍是 silent', () => {
    expect(atRatio(VOICE_BUDGET.SILENT_RATIO).level).toBe('silent');
    expect(atRatio(VOICE_BUDGET.WARNING_RATIO - 0.001).level).toBe('silent');
  });

  it('85% 进入告警档，100% 以下仍是 warning', () => {
    expect(atRatio(VOICE_BUDGET.WARNING_RATIO).level).toBe('warning');
    expect(atRatio(VOICE_BUDGET.BLOCK_RATIO - 0.001).level).toBe('warning');
  });

  it('100% 及超出都是 blocked', () => {
    expect(atRatio(VOICE_BUDGET.BLOCK_RATIO).level).toBe('blocked');
    expect(atRatio(1.2).level).toBe('blocked');
  });
});

describe('evaluateVoiceBudget 分钟 / 成本双轨', () => {
  it('只设分钟上限时成本字段保持透传但不参与档位', () => {
    const result = evaluateVoiceBudget({
      elapsedMs: 5 * 60_000,
      costAmount: 12,
      minuteLimit: 5,
      costLimit: null,
    });
    expect(result).toMatchObject({
      level: 'blocked',
      minutesUsed: 5,
      minutesLimit: 5,
      costAmount: 12,
      costLimit: null,
      usageRatio: 1,
    });
  });

  it('只设成本上限且尚无估算时不把缺失当成 0%', () => {
    const result = evaluateVoiceBudget({
      elapsedMs: 9 * 60_000,
      costAmount: null,
      minuteLimit: null,
      costLimit: 1,
    });
    expect(result).toMatchObject({
      level: 'none',
      usageRatio: 0,
      costAmount: null,
      costLimit: 1,
    });
  });

  it('只设成本上限且已有估算时按成本轨定档', () => {
    expect(evaluateVoiceBudget({
      elapsedMs: 1_000,
      costAmount: 0.85,
      minuteLimit: null,
      costLimit: 1,
    }).level).toBe('warning');
  });

  it('双轨同时开启时取占用比更高的那条', () => {
    const result = evaluateVoiceBudget({
      elapsedMs: 3 * 60_000,
      costAmount: 0.95,
      minuteLimit: 10,
      costLimit: 1,
    });
    expect(result.level).toBe('warning');
    expect(result.usageRatio).toBe(0.95);
  });

  it('0 或负数上限与未设相同', () => {
    expect(evaluateVoiceBudget({
      elapsedMs: TEN_MINUTES_MS,
      costAmount: 5,
      minuteLimit: 0,
      costLimit: -2,
    }).level).toBe('none');
  });
});

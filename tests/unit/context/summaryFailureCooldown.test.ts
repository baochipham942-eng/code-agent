import { describe, expect, it } from 'vitest';
import { nextSummaryFailureState } from '../../../src/host/agent/runtime/contextAssembly/compression';
import { COMPACTION_ECONOMICS } from '../../../src/shared/constants';

// WP2-3 摘要失败冷却：连续 N 次摘要失败（校验不过/调用异常）进入冷却期，
// 冷却期内跳过付费 AI 摘要，靠确定性层兜底。与 nextCompactionGuardState 同范式的纯状态转移。

const NOW = 1_000_000;
const { FAILURE_COOLDOWN_THRESHOLD, FAILURE_COOLDOWN_MS } = COMPACTION_ECONOMICS;

describe('nextSummaryFailureState', () => {
  it('success resets the streak and does not enter cooldown', () => {
    const next = nextSummaryFailureState({ streak: 2, failed: false, now: NOW });
    expect(next).toEqual({ streak: 0, cooldownUntil: 0 });
  });

  it('failures below threshold accumulate without cooldown', () => {
    const next = nextSummaryFailureState({ streak: 0, failed: true, now: NOW });
    expect(next.streak).toBe(1);
    expect(next.cooldownUntil).toBe(0);
  });

  it('reaching the threshold enters cooldown', () => {
    const next = nextSummaryFailureState({
      streak: FAILURE_COOLDOWN_THRESHOLD - 1,
      failed: true,
      now: NOW,
    });
    expect(next.streak).toBe(FAILURE_COOLDOWN_THRESHOLD);
    expect(next.cooldownUntil).toBe(NOW + FAILURE_COOLDOWN_MS);
  });

  it('further failures keep extending cooldown', () => {
    const next = nextSummaryFailureState({
      streak: FAILURE_COOLDOWN_THRESHOLD + 1,
      failed: true,
      now: NOW,
    });
    expect(next.cooldownUntil).toBe(NOW + FAILURE_COOLDOWN_MS);
  });
});

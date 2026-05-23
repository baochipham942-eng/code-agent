// 子代理 idle 阈值钳制 —— 锁住"idle 必须 < 总执行预算"，修复旧死配置（IDLE_TIMEOUT=120s ≥ 默认预算 90s
// → idle 看门狗永远来不及在总超时前触发）。取 min(IDLE_TIMEOUT, budget*0.9)。
import { describe, expect, it } from 'vitest';
import { getSubagentIdleTimeout, getSubagentExecutionTimeout } from '../../../src/main/agent/subagentExecutorCancellation';
import { CANCELLATION_TIMEOUTS } from '../../../src/shared/constants';

describe('getSubagentIdleTimeout', () => {
  it('默认 90s 预算：idle 阈值 81s（< 预算，旧 bug 是 120s ≥ 90s 永不触发）', () => {
    const budget = getSubagentExecutionTimeout('Unknown Agent'); // → DEFAULT 90_000
    expect(budget).toBe(90_000);
    const idle = getSubagentIdleTimeout(budget);
    expect(idle).toBe(81_000);
    expect(idle).toBeLessThan(budget);
  });

  it('小预算 45s：idle 阈值 40.5s（按 90% 钳制，仍 < 预算）', () => {
    const idle = getSubagentIdleTimeout(45_000);
    expect(idle).toBe(40_500);
    expect(idle).toBeLessThan(45_000);
  });

  it('大预算（如 200s）：被 IDLE_TIMEOUT 上限（120s）钳制', () => {
    const idle = getSubagentIdleTimeout(200_000);
    expect(idle).toBe(CANCELLATION_TIMEOUTS.IDLE_TIMEOUT);
    expect(idle).toBe(120_000);
  });

  it('任意预算下 idle 阈值都不超过预算本身（看门狗永远有机会先于总超时触发）', () => {
    for (const budget of [45_000, 60_000, 90_000, 120_000]) {
      expect(getSubagentIdleTimeout(budget)).toBeLessThan(budget);
    }
  });
});

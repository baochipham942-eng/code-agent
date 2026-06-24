// ADR-027 slice 1：信封预算账（纯逻辑）。预算闸是付费安全核心，逐条锁死不变量。
import { describe, it, expect } from 'vitest';
import {
  grantEnvelope,
  defaultAutonomyGrant,
  canAfford,
  consume,
  isExhausted,
  remaining,
} from '@shared/contract/designAutonomy';
import { DEFAULT_AUTONOMY_VARIANTS, MAX_AUTONOMY_VARIANTS } from '@shared/constants';
import { estimateImageCostCny } from '@shared/media/imageCost';

const T2I = estimateImageCostCny(); // 单张 t2i 兜底估价（价表唯一真源，=0.14）

describe('designAutonomy · 信封授权（grantEnvelope）', () => {
  it('无入参 → 默认变体数 + 价表派生的 ¥（含安全系数，¥ 上限不早于变体上限绑定）', () => {
    const env = grantEnvelope({});
    expect(env.maxVariants).toBe(DEFAULT_AUTONOMY_VARIANTS);
    expect(env.usedVariants).toBe(0);
    expect(env.spentCny).toBe(0);
    // 默认 ¥ 要够跑满默认变体数（否则信封自相矛盾）；且留 re-roll 头寸 → 严格大于裸成本。
    expect(env.maxCny).toBeGreaterThan(DEFAULT_AUTONOMY_VARIANTS * T2I);
  });

  it('变体数夹紧到 [1, MAX_AUTONOMY_VARIANTS]，越界/非法回落', () => {
    expect(grantEnvelope({ maxVariants: 999 }).maxVariants).toBe(MAX_AUTONOMY_VARIANTS);
    expect(grantEnvelope({ maxVariants: 0 }).maxVariants).toBe(1);
    expect(grantEnvelope({ maxVariants: -3 }).maxVariants).toBe(1);
    expect(grantEnvelope({ maxVariants: 2.7 }).maxVariants).toBe(2); // 向下取整
    expect(grantEnvelope({ maxVariants: Number.NaN }).maxVariants).toBe(DEFAULT_AUTONOMY_VARIANTS);
  });

  it('显式 maxCny 被采纳（人可改信封）；负/非法 ¥ 回落到派生默认', () => {
    expect(grantEnvelope({ maxCny: 0.5 }).maxCny).toBeCloseTo(0.5, 6);
    expect(grantEnvelope({ maxCny: -1 }).maxCny).toBe(defaultAutonomyGrant().maxCny);
    expect(grantEnvelope({ maxCny: Number.POSITIVE_INFINITY }).maxCny).toBe(defaultAutonomyGrant().maxCny);
  });
});

describe('designAutonomy · 预算闸（canAfford）', () => {
  it('有变体槽 ∧ est 不超剩余 ¥ → 可付费', () => {
    const env = grantEnvelope({ maxVariants: 3, maxCny: 0.5 });
    expect(canAfford(env, T2I)).toBe(true);
  });

  it('变体槽耗尽 → 拒（即便 ¥ 还剩）', () => {
    let env = grantEnvelope({ maxVariants: 1, maxCny: 10 });
    env = consume(env, { landed: true, costCny: T2I });
    expect(canAfford(env, T2I)).toBe(false);
  });

  it('单张 est 超出剩余 ¥ → 拒该张（红线①：付费前 est 闸）', () => {
    const env = grantEnvelope({ maxVariants: 5, maxCny: 0.1 }); // ¥ 不够一张
    expect(canAfford(env, T2I)).toBe(false);
  });

  it('剩余 ¥ 恰好等于 est → 放行（边界含等号，浮点容差）', () => {
    const env = grantEnvelope({ maxVariants: 5, maxCny: T2I });
    expect(canAfford(env, T2I)).toBe(true);
  });
});

describe('designAutonomy · 消费（consume）', () => {
  it('成功落地 → 吃一个变体槽 + 累加实际 ¥', () => {
    const env = consume(grantEnvelope({ maxVariants: 3, maxCny: 1 }), { landed: true, costCny: 0.14 });
    expect(env.usedVariants).toBe(1);
    expect(env.spentCny).toBeCloseTo(0.14, 6);
  });

  it('失败不吃变体槽（D2：失败不占版本上限）；无扣费则 ¥ 不动', () => {
    const env = consume(grantEnvelope({ maxVariants: 3, maxCny: 1 }), { landed: false, costCny: 0 });
    expect(env.usedVariants).toBe(0);
    expect(env.spentCny).toBe(0);
  });

  it('失败但仍被扣费（罕见）→ ¥ 照实累加、变体槽不动（¥ 账永远诚实）', () => {
    const env = consume(grantEnvelope({ maxVariants: 3, maxCny: 1 }), { landed: false, costCny: 0.05 });
    expect(env.usedVariants).toBe(0);
    expect(env.spentCny).toBeCloseTo(0.05, 6);
  });
});

describe('designAutonomy · 耗尽与剩余（isExhausted / remaining）', () => {
  it('变体上限触顶即耗尽', () => {
    let env = grantEnvelope({ maxVariants: 2, maxCny: 10 });
    env = consume(env, { landed: true, costCny: 0.14 });
    expect(isExhausted(env)).toBe(false);
    env = consume(env, { landed: true, costCny: 0.14 });
    expect(isExhausted(env)).toBe(true);
  });

  it('¥ 花光即耗尽（即便变体槽还剩）', () => {
    let env = grantEnvelope({ maxVariants: 9, maxCny: 0.2 });
    env = consume(env, { landed: true, costCny: 0.2 });
    expect(isExhausted(env)).toBe(true);
  });

  it('remaining 返回非负的剩余变体数与 ¥', () => {
    let env = grantEnvelope({ maxVariants: 3, maxCny: 0.5 });
    env = consume(env, { landed: true, costCny: 0.14 });
    expect(remaining(env)).toEqual({ variants: 2, cny: expect.closeTo(0.36, 6) });
  });

  it('全流程：批 3 张信封 → 跑满 3 张成功 → 第 4 张被预算闸硬停', () => {
    let env = grantEnvelope({ maxVariants: 3, maxCny: 1 });
    for (let i = 0; i < 3; i++) {
      expect(canAfford(env, T2I)).toBe(true);
      env = consume(env, { landed: true, costCny: T2I });
    }
    expect(isExhausted(env)).toBe(true);
    expect(canAfford(env, T2I)).toBe(false); // 信封耗尽硬停
  });
});

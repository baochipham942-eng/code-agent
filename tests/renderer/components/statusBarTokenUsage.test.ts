// WP-2：token 状态栏死链修复——数字改经 BudgetStatus surface 拉活值
import { describe, expect, it } from 'vitest';
import { normalizeBudgetStatus } from '../../../src/renderer/hooks/useBudgetStatus';
import { resolveDisplayTokens } from '../../../src/renderer/components/StatusBar/TokenUsage';

describe('normalizeBudgetStatus tokenUsage (WP-2)', () => {
  it('passes through token usage sums', () => {
    const view = normalizeBudgetStatus({
      currentCost: 1,
      maxBudget: 10,
      usagePercentage: 0.1,
      alertLevel: 'none',
      config: { enabled: true },
      tokenUsage: { inputTokens: 1500, outputTokens: 500, cacheReadTokens: 2000, cacheCreationTokens: 100 },
    });
    expect(view?.tokenUsage).toEqual({
      inputTokens: 1500,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreationTokens: 100,
    });
  });

  it('guards NaN/Infinity/negative garbage to zero', () => {
    const view = normalizeBudgetStatus({
      tokenUsage: {
        inputTokens: Number.NaN,
        outputTokens: Number.POSITIVE_INFINITY,
        cacheReadTokens: -5,
        cacheCreationTokens: undefined,
      },
    });
    expect(view?.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('omits tokenUsage when host does not report it (older host)', () => {
    const view = normalizeBudgetStatus({ currentCost: 1 });
    expect(view?.tokenUsage).toBeUndefined();
  });
});

describe('resolveDisplayTokens (WP-2)', () => {
  it('input 显示口径 = 非缓存输入 + 缓存读 + 缓存写（与 provider 报告的提交总量对齐）', () => {
    expect(
      resolveDisplayTokens({
        enabled: true,
        currentCost: 0,
        maxBudget: 0,
        usagePercentage: 0,
        alertLevel: 'none',
        tokenUsage: { inputTokens: 1500, outputTokens: 500, cacheReadTokens: 2000, cacheCreationTokens: 100 },
      }),
    ).toEqual({ input: 3600, output: 500 });
  });

  it('budget 状态缺失/无 tokenUsage 时回落 0（状态栏显示 0/0 而非崩溃）', () => {
    expect(resolveDisplayTokens(null)).toEqual({ input: 0, output: 0 });
    expect(
      resolveDisplayTokens({
        enabled: false,
        currentCost: 0,
        maxBudget: 0,
        usagePercentage: 0,
        alertLevel: 'none',
      }),
    ).toEqual({ input: 0, output: 0 });
  });
});

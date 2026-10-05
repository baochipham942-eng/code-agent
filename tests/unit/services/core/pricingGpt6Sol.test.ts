// N-MODELCAT-GPT6-SOL：GPT-6 Sol 系列分段定价经公开预算 API（BudgetService）的算价断言。
// 价目与 272K 分段规则来自 OpenAI 官方模型页（抓取 2026-09-30）：
//   https://developers.openai.com/api/docs/models/gpt-6-sol
//   https://developers.openai.com/api/docs/models/gpt-6.1-sol
import { describe, expect, it } from 'vitest';
import { BudgetService } from '../../../../src/host/services/core/budgetService';

function costUsd(model: string, usage: {
  inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number;
}): number {
  const service = new BudgetService({ enabled: true, maxBudget: 1_000_000, resetPeriodHours: 24 });
  service.recordUsage({ ...usage, model, provider: 'openai', timestamp: 1 });
  return service.getCurrentCost();
}

describe('GPT-6 Sol tiered pricing through the budget API', () => {
  it('gpt-6.1-sol: prompt 150K stays at base rates (0.305 USD)', () => {
    // 输入 100000×$2 + 缓存读 50000×$0.10 + 输出 10000×$10（每 1M）
    expect(costUsd('gpt-6.1-sol', { inputTokens: 100000, cacheReadTokens: 50000, outputTokens: 10000 }))
      .toBeCloseTo(0.305, 12);
  });

  it('gpt-6.1-sol: prompt 300K applies the full-request tier (0.97 USD)', () => {
    // 输入 200000×$4 + 缓存读 100000×$0.20 + 输出 10000×$15（每 1M，×2/×2/×1.5）
    expect(costUsd('gpt-6.1-sol', { inputTokens: 200000, cacheReadTokens: 100000, outputTokens: 10000 }))
      .toBeCloseTo(0.97, 12);
  });

  it('the 272000/272001 prompt boundary flips the tier for the whole request', () => {
    const atThreshold = costUsd('gpt-6.1-sol', { inputTokens: 272000, outputTokens: 1000 });
    const aboveThreshold = costUsd('gpt-6.1-sol', { inputTokens: 272001, outputTokens: 1000 });
    expect(atThreshold).toBeCloseTo((272000 / 1e6) * 2 + (1000 / 1e6) * 10, 12);
    expect(aboveThreshold).toBeCloseTo((272001 / 1e6) * (2 * 2) + (1000 / 1e6) * (10 * 1.5), 12);
    // 1 token 之差：输入价翻倍、输出价 ×1.5，整单生效
    expect(aboveThreshold).toBeGreaterThan(atThreshold * 1.9);
  });

  it('charges cache writes at the explicit $2.50 rate', () => {
    expect(costUsd('gpt-6.1-sol', { inputTokens: 100000, outputTokens: 0, cacheCreationTokens: 10000 }))
      .toBeCloseTo((100000 / 1e6) * 2 + (10000 / 1e6) * 2.5, 12);
  });

  it('gpt-6-sol: same shapes at cacheRead $0.20', () => {
    expect(costUsd('gpt-6-sol', { inputTokens: 100000, cacheReadTokens: 50000, outputTokens: 10000 }))
      .toBeCloseTo(0.305 + (50000 / 1e6) * 0.1, 12);
    expect(costUsd('gpt-6-sol', { inputTokens: 200000, cacheReadTokens: 100000, outputTokens: 10000 }))
      .toBeCloseTo(0.8 + (100000 / 1e6) * 0.4 + 0.15, 12);
    expect(costUsd('gpt-6-sol', { inputTokens: 272000, outputTokens: 1000 }))
      .toBeCloseTo((272000 / 1e6) * 2 + (1000 / 1e6) * 10, 12);
    expect(costUsd('gpt-6-sol', { inputTokens: 272001, outputTokens: 1000 }))
      .toBeCloseTo((272001 / 1e6) * 4 + (1000 / 1e6) * 15, 12);
  });
});

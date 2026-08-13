import { describe, expect, it } from 'vitest';
import { BudgetService } from '../../../src/host/services/core/budgetService';

function recordOneMillionTokens(provider: string, model: string): number {
  const service = new BudgetService({ enabled: true, maxBudget: 100 });
  service.recordUsage({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    model,
    provider,
    timestamp: Date.now(),
  });
  return service.getCurrentCost();
}

describe('BudgetService 策展价判定', () => {
  it('custom provider 的日期样式同名模型回落 default 档', () => {
    const cost = recordOneMillionTokens('custom-tokenrhythm', 'deepseek-v4-flash-0731');
    expect(cost).toBeCloseTo(4, 6);
    expect(cost).not.toBeCloseTo(0.42, 6);
  });

  it('内置 provider 的精确模型仍使用官方价', () => {
    expect(recordOneMillionTokens('deepseek', 'deepseek-chat')).toBeCloseTo(0.42, 6);
  });

  it('OpenAI 日期版本继续匹配其基础模型的官方价', () => {
    expect(recordOneMillionTokens('openai', 'gpt-4o-2024-08-06')).toBeCloseTo(12.5, 6);
  });

  it('内置 provider 的未知模型继续回落 default 档', () => {
    expect(recordOneMillionTokens('deepseek', 'unknown-model')).toBeCloseTo(4, 6);
  });
});

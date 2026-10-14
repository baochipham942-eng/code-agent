import { describe, expect, it } from 'vitest';
import { BudgetService } from '../../../src/host/services/core/budgetService';
import { SERVICE_TIER_COST_MULTIPLIER, UNATTENDED_SERVICE_TIER } from '../../../src/shared/constants';

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

// N-MODELCAT-SERVICE-TIER-COST：usage 带 serviceTier → calculateCost 按档位倍率
// 折价，run 总额（getCurrentCost）与档位缺失时逐位一致地保持原价。
describe('BudgetService service_tier 档位计价', () => {
  const RECORD = { inputTokens: 1_000_000, outputTokens: 1_000_000, model: 'gpt-6.1-sol', provider: 'openai' };

  function recordCost(serviceTier?: string): number {
    const service = new BudgetService({ enabled: true, maxBudget: 100 });
    service.recordUsage({ ...RECORD, timestamp: Date.now(), ...(serviceTier ? { serviceTier } : {}) });
    return service.getCurrentCost();
  }

  it('serviceTier=flex → 总额乘 0.5（含 longContext 档，无人值守 run 的真实花费）', () => {
    const standard = recordCost();
    const flex = recordCost(UNATTENDED_SERVICE_TIER);
    // 1M in + 1M out 超 gpt-6.1-sol 272K 阈值 → longContext 计价 $2×2 + $10×1.5 = $19；
    // flex 倍率在 longContext 之上再乘 0.5 = $9.5（item 3：long-context math included）
    expect(standard).toBeCloseTo(19, 6);
    expect(flex).toBeCloseTo(19 * SERVICE_TIER_COST_MULTIPLIER.flex, 6);
  });

  it.each([
    ['档位缺席（绝大多数 provider）', undefined],
    ['实报 standard（被拒摘档重试后的响应）', 'standard'],
  ])('%s → 与改动前逐位一致', (_label, tier) => {
    expect(recordCost(tier)).toBe(recordCost());
  });
});

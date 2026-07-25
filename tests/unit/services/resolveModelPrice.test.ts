import { describe, expect, it } from 'vitest';
import {
  PRICING_BASELINE_DEFAULT,
  computeCoef,
  estimateTurnCostUsd,
  formatCoefLabel,
  resolveModelPrice,
} from '../../../src/shared/pricing/resolveModelPrice';

describe('resolveModelPrice 五档证据等级', () => {
  it('user 覆盖优先于一切', () => {
    const price = resolveModelPrice('deepseek', 'deepseek-chat', {
      'deepseek/deepseek-chat': { inputPerMTok: 9, outputPerMTok: 9 },
    });
    expect(price.source).toBe('user');
    expect(price.inputPerMTok).toBe(9);
  });

  it('catalog 策展价（含已知免费档 0，区别于 unknown）', () => {
    const chat = resolveModelPrice('deepseek', 'deepseek-chat');
    expect(chat.source).toBe('catalog');
    expect(chat.inputPerMTok).toBeGreaterThan(0);

    const mimo = resolveModelPrice('xiaomi', 'mimo-v2.5-pro');
    expect(mimo.source).toBe('catalog');
    expect(mimo.inputPerMTok).toBe(0); // Token Plan 包月，已知为 0
  });

  it('local provider 一律已知为 0（本地推理无 API 账单）', () => {
    const price = resolveModelPrice('local', 'qwen3.5:9b');
    expect(price.source).toBe('catalog');
    expect(price.inputPerMTok).toBe(0);
  });

  it('litellm 快照兜住策展表以外的目录模型', () => {
    const price = resolveModelPrice('openai', 'gpt-5.5');
    expect(price.source).toBe('litellm');
    expect(price.inputPerMTok).toBeGreaterThan(0);
    expect(price.updatedAt).toBeTruthy();
  });

  it('无权威价 → unknown，绝不落兜底价（治「default $1/$3 装精确」的病）', () => {
    const price = resolveModelPrice('custom', 'custom-model');
    expect(price.source).toBe('unknown');
    expect(price.inputPerMTok).toBeUndefined();
  });

  it("历史兜底键 'default' 不是价格证据", () => {
    expect(resolveModelPrice('whatever', 'default').source).toBe('unknown');
  });
});

describe('coef 与本轮估算', () => {
  const baseline = resolveModelPrice(PRICING_BASELINE_DEFAULT.provider, PRICING_BASELINE_DEFAULT.modelId);

  it('基准自身 coef = 1.00x，且基准必须有价（1.0x 锚点约束）', () => {
    expect(baseline.source).not.toBe('unknown');
    expect(formatCoefLabel(computeCoef(baseline, baseline))).toBe('1.00x');
  });

  it('unknown 模型 coef 与估算都为 null（UI 显示 —）', () => {
    const price = resolveModelPrice('custom', 'custom-model');
    expect(computeCoef(price, baseline)).toBeNull();
    expect(estimateTurnCostUsd(price, { inputTokens: 1000, outputTokens: 1000 })).toBeNull();
  });

  it('免费档显示 ≈0x 而非 —', () => {
    const free = resolveModelPrice('zhipu', 'glm-4-flash');
    expect(formatCoefLabel(computeCoef(free, baseline))).toBe('≈0x');
  });

  it('本轮估算按 token 线性', () => {
    const price = resolveModelPrice('deepseek', 'deepseek-v4-pro');
    const usd = estimateTurnCostUsd(price, { inputTokens: 1_000_000, outputTokens: 0 });
    expect(usd).toBeCloseTo(price.inputPerMTok as number, 6);
  });
});

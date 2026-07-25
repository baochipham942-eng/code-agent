import { describe, expect, it } from 'vitest';
import { getModelPriceBadge } from '../../../src/renderer/components/StatusBar/ModelSwitcher';

describe('model menu price badge (设计稿 §8.1)', () => {
  it('known model shows a coefficient label', () => {
    const badge = getModelPriceBadge('deepseek', 'deepseek-v4-pro');
    expect(badge.known).toBe(true);
    expect(badge.label).toBe('1.00x'); // 基准模型自身
  });

  it('unknown model shows — and never a fake number', () => {
    const badge = getModelPriceBadge('custom', 'custom-model');
    expect(badge.known).toBe(false);
    expect(badge.label).toBe('—');
  });
});

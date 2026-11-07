import { describe, expect, it } from 'vitest';
import { isZeroPricedModel } from '../../../../src/shared/constants';

describe('isZeroPricedModel', () => {
  it.each([
    ['xiaomi', 'mimo-v2.6-flash'],
    ['zhipu', 'glm-5.3-flash'],
    ['moonshot', 'kimi-k2.5'],
  ])('包月模型 %s/%s 为 true', (provider, model) => {
    expect(isZeroPricedModel(provider, model)).toBe(true);
  });

  it.each([
    ['zhipu', 'glm-5.3'],
    ['moonshot', 'kimi-k2.6'],
    ['custom', 'my-private-model'],
  ])('按量/未知模型 %s/%s 为 false', (provider, model) => {
    expect(isZeroPricedModel(provider, model)).toBe(false);
  });
});

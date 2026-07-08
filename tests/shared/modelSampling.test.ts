import { describe, expect, it } from 'vitest';
import {
  getModelTemperatureControl,
  normalizeSamplingModelId,
  requiresDefaultOnlyTemperature,
  resolveModelRequestTemperature,
} from '../../src/shared/modelSampling';

describe('model sampling constraints', () => {
  it('normalizes provider-prefixed model ids', () => {
    expect(normalizeSamplingModelId('openai/gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeSamplingModelId(' GPT-5.5-Pro ')).toBe('gpt-5.5-pro');
  });

  it('locks default-only temperature models to 1', () => {
    expect(requiresDefaultOnlyTemperature('gpt-5.5')).toBe(true);
    expect(requiresDefaultOnlyTemperature('openai/gpt-5.5')).toBe(true);
    expect(resolveModelRequestTemperature('gpt-5.5', 0.7)).toBe(1);
    expect(getModelTemperatureControl('gpt-5.5')).toEqual({
      locked: true,
      reason: 'default_only',
      temperature: 1,
    });
  });

  it('preserves custom temperature for models without a constraint', () => {
    expect(requiresDefaultOnlyTemperature('gpt-5.4-mini')).toBe(false);
    expect(resolveModelRequestTemperature('gpt-5.4-mini', 0.3)).toBe(0.3);
    expect(resolveModelRequestTemperature('gpt-5.4-mini', undefined)).toBeUndefined();
    expect(getModelTemperatureControl('gpt-5.4-mini')).toEqual({ locked: false });
  });
});

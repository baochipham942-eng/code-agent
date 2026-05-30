import { describe, expect, it } from 'vitest';
import { applyEffortControls } from '../../../src/main/agent/runtime/contextAssembly/effortControls';
import type { ModelConfig } from '../../../src/shared/contract/model';

const baseConfig: ModelConfig = {
  provider: 'xiaomi',
  model: 'mimo-v2.5-pro',
};

describe('applyEffortControls', () => {
  it('keeps effort intensity independent from the thinking switch', () => {
    expect(applyEffortControls(baseConfig, 'low')).toMatchObject({
      provider: 'xiaomi',
      reasoningEffort: 'low',
      thinkingBudget: 2048,
    });
    expect(applyEffortControls(baseConfig, 'medium')).toMatchObject({
      reasoningEffort: 'medium',
      thinkingBudget: 8192,
    });
    expect(applyEffortControls(baseConfig, 'high')).toMatchObject({
      reasoningEffort: 'high',
      thinkingBudget: 16384,
    });
  });

  it('does not add provider thinking controls when thinking is off', () => {
    expect(applyEffortControls(baseConfig, 'high', { thinkingEnabled: false })).toEqual({
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      thinkingBudget: undefined,
      reasoningEffort: undefined,
    });
  });
});

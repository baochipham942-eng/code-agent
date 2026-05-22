import { describe, expect, it } from 'vitest';
import { ModelSessionState } from '../../../src/main/session/modelSessionState';

describe('ModelSessionState', () => {
  it('preserves adaptive mode in effective config', () => {
    const state = new ModelSessionState();

    state.setOverride('session-1', {
      provider: 'openai',
      model: 'gpt-5.5',
      adaptive: true,
    });

    expect(state.getEffectiveConfig('session-1', {
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      adaptive: false,
    })).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5',
      adaptive: true,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { ControlState } from '../../../../src/host/agent/runtime/controlState';

describe('ControlState settlement', () => {
  it('starts unsettled and becomes settled when marked', () => {
    const state = new ControlState();

    expect(state.isSettled).toBe(false);

    state.markSettled();

    expect(state.isSettled).toBe(true);
  });

  it('supports seeding settled state for tests', () => {
    expect(ControlState.forTest({ isSettled: true }).isSettled).toBe(true);
  });
});

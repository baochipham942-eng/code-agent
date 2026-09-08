import { describe, expect, it } from 'vitest';
import { ControlState } from '../../../../src/host/agent/runtime/controlState';

describe('ControlState settlement', () => {
  it('keeps memory taint across external-query counter resets and isolates new runs', () => {
    const state = new ControlState();
    state.markMemoryTainted();
    state.incrementExternalDataCalls();
    state.resetExternalDataCalls();
    expect(state.memoryTainted).toBe(true);
    expect(new ControlState().memoryTainted).toBe(false);
  });

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

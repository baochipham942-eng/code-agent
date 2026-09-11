import { describe, expect, it } from 'vitest';
import { createBackCoordinator } from '../../../packages/mobile/src/app/backCoordinator';

function deps(overrides: Partial<Parameters<typeof createBackCoordinator>[0]> = {}) {
  const calls: string[] = [];
  const fake = {
    ports: {
      keyboard: { hide: async () => { calls.push('hide-keyboard'); } },
      lifecycle: { leave: async () => { calls.push('leave'); } },
    },
    hasSelection: () => false,
    clearSelection: () => { calls.push('clear-selection'); },
    isKeyboardVisible: () => false,
    dismissLayer: () => { calls.push('dismiss-layer'); return true; },
    onNativeError: () => { calls.push('native-error'); },
    ...overrides,
  };
  return { coordinator: createBackCoordinator(fake), calls };
}

describe('android back priority (MN-02)', () => {
  it('clears an active text selection before touching keyboard, layers or the OS', () => {
    const { coordinator, calls } = deps({ hasSelection: () => true, isKeyboardVisible: () => true });
    expect(coordinator.onBack()).toBe('selection-cleared');
    expect(calls).toEqual(['clear-selection']);
  });
  it('hides the keyboard next, leaving sheets and drawers for the following press', () => {
    const { coordinator, calls } = deps({ isKeyboardVisible: () => true });
    expect(coordinator.onBack()).toBe('keyboard-hidden');
    expect(calls).toEqual(['hide-keyboard']);
  });
  it('consumes a back press while a sheet page or drawer is open', () => {
    const { coordinator, calls } = deps();
    expect(coordinator.onBack()).toBe('layer-dismissed');
    expect(calls).toEqual(['dismiss-layer']);
  });
  it('hands the root conversation back to the OS only after every layer is consumed', () => {
    const { coordinator, calls } = deps({ dismissLayer: () => false });
    expect(coordinator.onBack()).toBe('left-app');
    expect(calls).toEqual(['leave']);
  });
  it('keeps the full order across consecutive presses: selection, keyboard, layers, OS', () => {
    const state = { selection: true, keyboard: true, layers: 2 };
    const calls: string[] = [];
    const coordinator = createBackCoordinator({
      ports: {
        keyboard: { hide: async () => { state.keyboard = false; calls.push('hide-keyboard'); } },
        lifecycle: { leave: async () => { calls.push('leave'); } },
      },
      hasSelection: () => state.selection,
      clearSelection: () => { state.selection = false; calls.push('clear-selection'); },
      isKeyboardVisible: () => state.keyboard,
      dismissLayer: () => { calls.push('dismiss-layer'); return state.layers-- > 0; },
      onNativeError: () => calls.push('native-error'),
    });
    expect([coordinator.onBack(), coordinator.onBack(), coordinator.onBack(), coordinator.onBack(), coordinator.onBack()])
      .toEqual(['selection-cleared', 'keyboard-hidden', 'layer-dismissed', 'layer-dismissed', 'left-app']);
    expect(calls).toEqual(['clear-selection', 'hide-keyboard', 'dismiss-layer', 'dismiss-layer', 'dismiss-layer', 'leave']);
  });
  it('reports a native failure when handing back to the OS fails', async () => {
    const calls: string[] = [];
    const failing = createBackCoordinator({
      ports: { keyboard: { hide: async () => {} }, lifecycle: { leave: async () => { throw new Error('BRIDGE_GONE'); } } },
      hasSelection: () => false, clearSelection: () => {}, isKeyboardVisible: () => false,
      dismissLayer: () => false, onNativeError: () => calls.push('native-error'),
    });
    expect(failing.onBack()).toBe('left-app');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toEqual(['native-error']);
  });
});

describe('predictive back cancellation (MN-02)', () => {
  it('mutates nothing when the system abandons the gesture', () => {
    const { coordinator, calls } = deps({ hasSelection: () => true, isKeyboardVisible: () => true });
    expect(coordinator.onBackCancelled()).toBeUndefined();
    expect(coordinator.onBackCancelled()).toBeUndefined();
    expect(calls).toEqual([]);
    // The next committed press still starts from the top of the priority chain.
    expect(coordinator.onBack()).toBe('selection-cleared');
    expect(calls).toEqual(['clear-selection']);
  });
});

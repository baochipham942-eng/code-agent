import { describe, it, expect } from 'vitest';
import {
  dispatchCanvasDeleteKey,
  shouldHandleCanvasDelete,
  type CanvasDeleteKeyEventLike,
} from '@renderer/components/design/canvasDeleteKeybinding';

const ev = (over: Partial<CanvasDeleteKeyEventLike> = {}): CanvasDeleteKeyEventLike => ({
  key: 'Backspace',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  targetTag: 'DIV',
  targetEditable: false,
  ...over,
});

const opts = (over?: Partial<{ annotMode: boolean; comparing: boolean; selectedCount: number }>) => ({
  annotMode: false,
  comparing: false,
  selectedCount: 1,
  ...over,
});

describe('shouldHandleCanvasDelete', () => {
  it('handles Backspace and Delete when a canvas node is selected', () => {
    expect(shouldHandleCanvasDelete(ev({ key: 'Backspace' }), opts())).toBe(true);
    expect(shouldHandleCanvasDelete(ev({ key: 'Delete' }), opts())).toBe(true);
  });

  it('ignores unrelated keys and empty selection', () => {
    expect(shouldHandleCanvasDelete(ev({ key: 'z' }), opts())).toBe(false);
    expect(shouldHandleCanvasDelete(ev(), opts({ selectedCount: 0 }))).toBe(false);
  });

  it('lets text inputs, IME, and modified shortcuts keep native behavior', () => {
    expect(shouldHandleCanvasDelete(ev({ targetTag: 'INPUT' }), opts())).toBe(false);
    expect(shouldHandleCanvasDelete(ev({ targetTag: 'TEXTAREA' }), opts())).toBe(false);
    expect(shouldHandleCanvasDelete(ev({ targetTag: 'SELECT' }), opts())).toBe(false);
    expect(shouldHandleCanvasDelete(ev({ targetEditable: true }), opts())).toBe(false);
    expect(shouldHandleCanvasDelete(ev({ isComposing: true }), opts())).toBe(false);
    expect(shouldHandleCanvasDelete(ev({ metaKey: true }), opts())).toBe(false);
    expect(shouldHandleCanvasDelete(ev({ ctrlKey: true }), opts())).toBe(false);
    expect(shouldHandleCanvasDelete(ev({ altKey: true }), opts())).toBe(false);
  });

  it('does not delete while annotating or comparing', () => {
    expect(shouldHandleCanvasDelete(ev(), opts({ annotMode: true }))).toBe(false);
    expect(shouldHandleCanvasDelete(ev(), opts({ comparing: true }))).toBe(false);
  });
});

describe('dispatchCanvasDeleteKey', () => {
  it('dispatches deleteSelected and returns true when handled', () => {
    let calls = 0;
    const handled = dispatchCanvasDeleteKey(ev(), opts(), { deleteSelected: () => { calls += 1; } });
    expect(handled).toBe(true);
    expect(calls).toBe(1);
  });

  it('returns false without dispatching when not handled', () => {
    let calls = 0;
    const handled = dispatchCanvasDeleteKey(ev({ targetTag: 'INPUT' }), opts(), {
      deleteSelected: () => { calls += 1; },
    });
    expect(handled).toBe(false);
    expect(calls).toBe(0);
  });
});

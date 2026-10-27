// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScrollEdgeFade } from '../../../src/renderer/hooks/useScrollEdgeFade';

describe('useScrollEdgeFade', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((frame: number) => frames.delete(frame)));
  });

  afterEach(() => vi.unstubAllGlobals());

  const flushFrame = () => {
    const callback = frames.values().next().value;
    frames.clear();
    act(() => callback?.(0));
  };

  it('turns off only the edge touching the scroller boundary', () => {
    const scroller = document.createElement('div');
    Object.defineProperties(scroller, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 300 },
    });
    scroller.scrollTop = 0;
    const { unmount } = renderHook(() => useScrollEdgeFade(scroller));
    flushFrame();
    expect(scroller.dataset.fadeTop).toBe('false');
    expect(scroller.dataset.fadeBottom).toBe('true');

    scroller.scrollTop = 100;
    act(() => scroller.dispatchEvent(new Event('scroll')));
    flushFrame();
    expect(scroller.dataset.fadeTop).toBe('true');
    expect(scroller.dataset.fadeBottom).toBe('true');

    scroller.scrollTop = 200;
    act(() => scroller.dispatchEvent(new Event('scroll')));
    flushFrame();
    expect(scroller.dataset.fadeTop).toBe('true');
    expect(scroller.dataset.fadeBottom).toBe('false');
    unmount();
  });

  it('throttles passive scroll events to one animation frame', () => {
    const scroller = document.createElement('div');
    const addEventListener = vi.spyOn(scroller, 'addEventListener');
    const { unmount } = renderHook(() => useScrollEdgeFade(scroller));
    flushFrame();
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(frames.size).toBe(1);
    expect(addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(nextFrame);
  });
});

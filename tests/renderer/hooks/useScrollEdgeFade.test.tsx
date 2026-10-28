// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScrollEdgeFade } from '../../../src/renderer/hooks/useScrollEdgeFade';

describe('useScrollEdgeFade', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let resizeObservers: Array<{
    callback: ResizeObserverCallback;
    observed: Set<Element>;
  }>;

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    resizeObservers = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((frame: number) => frames.delete(frame)));
    vi.stubGlobal('ResizeObserver', class {
      observed = new Set<Element>();
      constructor(readonly callback: ResizeObserverCallback) {
        resizeObservers.push(this);
      }
      observe(element: Element) {
        this.observed.add(element);
      }
      disconnect() {
        this.observed.clear();
      }
    });
    vi.stubGlobal('MutationObserver', class {
      observe() {}
      disconnect() {}
    });
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
    const { result, unmount } = renderHook(() => useScrollEdgeFade());
    act(() => result.current(scroller));
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

  it('recomputes after content and viewport resize without a scroll event', () => {
    const scroller = document.createElement('div');
    const content = document.createElement('div');
    scroller.append(content);
    let clientHeight = 100;
    let scrollHeight = 300;
    Object.defineProperties(scroller, {
      clientHeight: { get: () => clientHeight },
      scrollHeight: { get: () => scrollHeight },
    });
    scroller.scrollTop = 200;
    const { result, unmount } = renderHook(() => useScrollEdgeFade());
    act(() => result.current(scroller));
    flushFrame();
    expect(scroller.dataset.fadeBottom).toBe('false');
    expect(resizeObservers[0].observed).toContain(content);

    scrollHeight = 400;
    act(() => resizeObservers[0].callback([], {} as ResizeObserver));
    flushFrame();
    expect(scroller.dataset.fadeBottom).toBe('true');

    clientHeight = 200;
    act(() => resizeObservers[0].callback([], {} as ResizeObserver));
    flushFrame();
    expect(scroller.dataset.fadeBottom).toBe('false');
    unmount();
  });

  it('throttles passive scroll events to one animation frame', () => {
    const scroller = document.createElement('div');
    const addEventListener = vi.spyOn(scroller, 'addEventListener');
    const { result, unmount } = renderHook(() => useScrollEdgeFade());
    act(() => result.current(scroller));
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

  it('uses typed zero for edge-free mask stops', () => {
    const css = readFileSync('src/renderer/styles/global.css', 'utf8');
    expect(css).toContain('--chat-fade-top: 0px');
    expect(css).toContain('--chat-fade-bottom: 0px');
  });
});

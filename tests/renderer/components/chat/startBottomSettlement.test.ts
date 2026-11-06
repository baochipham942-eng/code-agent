import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceTurn } from '../../../../src/shared/contract/trace';
import { startBottomSettlement } from '../../../../src/renderer/components/features/chat/useSessionEntryScroll';

describe('startBottomSettlement', () => {
  let queue: Array<() => void>;
  beforeEach(() => {
    queue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => queue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  // Browser-like scroller: scrollTop writes clamp to scrollHeight - clientHeight.
  function makeScroller(heightAt: (frame: number) => number) {
    let frame = 0;
    let top = 0;
    const scroller = {
      clientHeight: 500,
      get scrollHeight() { return heightAt(frame); },
      get scrollTop() { return top; },
      set scrollTop(v: number) { top = Math.min(v, this.scrollHeight - this.clientHeight); },
    };
    return { scroller, tick: () => { frame += 1; } };
  }

  function run(heightAt: (frame: number) => number) {
    const turns: TraceTurn[] = [];
    const { scroller, tick } = makeScroller(heightAt);
    const onSettled = vi.fn();
    const onCancel = vi.fn();
    startBottomSettlement({
      turnsAtJump: turns,
      projectionTurnsRef: { current: turns },
      scrollerElementRef: { current: scroller as unknown as HTMLElement },
      keepActiveOutputVisibleRef: { current: true },
      activeDisplayScrollCancelRef: { current: null },
      onSettled,
      onCancel,
    });
    let frames = 0;
    while (queue.length > 0) {
      const cb = queue.shift()!;
      frames += 1;
      cb();
      tick();
    }
    return { frames, onSettled, onCancel };
  }

  it('stops early once scrollHeight is stable and the scroller is at the bottom', () => {
    const { frames, onSettled, onCancel } = run(() => 3000);
    expect(frames).toBeLessThan(60);
    expect(frames).toBe(9);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('keeps going while scrollHeight still grows, up to the 60-frame cap', () => {
    const { frames, onSettled } = run((frame) => 3000 + frame * 40);
    expect(frames).toBe(60);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

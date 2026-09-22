import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StallObserver,
  holdStallClock,
  stallClockHeld,
  startForegroundStallWatch,
} from '../../../src/host/agent/stallObserver';

describe('StallObserver', () => {
  it('hints at 90s and escalates at 5min while a tool is quiet', () => {
    const observer = new StallObserver(0);
    expect(observer.tick(89_000, 'tool', 'Read')).toBeNull();
    expect(observer.tick(90_000, 'tool', 'Read')).toEqual({
      level: 'hint', phase: 'tool', detail: 'Read',
    });
    expect(observer.tick(120_000, 'tool', 'Read')).toBeNull();
    expect(observer.tick(300_000, 'tool', 'Read')).toEqual({
      level: 'escalated', phase: 'tool', detail: 'Read',
    });
  });

  it('resets the clock when something visible happens', () => {
    const observer = new StallObserver(0);
    observer.noteProgress('tool:1', 80_000);
    expect(observer.tick(160_000, 'model', '等模型回响')).toBeNull();
    expect(observer.tick(170_000, 'model', '等模型回响')).toEqual({
      level: 'hint', phase: 'model', detail: '等模型回响',
    });
  });

  it('a decision wait does not keep the idle clock running', () => {
    const observer = new StallObserver(0);
    expect(observer.tick(90_000, 'tool', 'Bash')).toEqual({
      level: 'hint', phase: 'tool', detail: 'Bash',
    });
    expect(observer.hold(4 * 60_000)).toBe(true);
    expect(observer.tick(4 * 60_000 + 89_000, 'tool', 'Bash')).toBeNull();
    expect(observer.tick(4 * 60_000 + 90_000, 'tool', 'Bash')).toEqual({
      level: 'hint', phase: 'tool', detail: 'Bash',
    });
  });

  it('holds the session clock only while a decision is open', () => {
    expect(stallClockHeld('session-a')).toBe(false);
    const release = holdStallClock('session-a');
    const nested = holdStallClock('session-a');
    expect(stallClockHeld('session-a')).toBe(true);
    release();
    expect(stallClockHeld('session-a')).toBe(true);
    nested();
    expect(stallClockHeld('session-a')).toBe(false);
    expect(holdStallClock(undefined)()).toBeUndefined();
  });

  it('does not escalate across a decision that was open the whole time', () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const clear = vi.fn();
    let held = false;
    let now = 0;
    const stop = startForegroundStallWatch({
      snapshot: () => ({ progressKey: 'same', phase: 'tool', detail: 'Bash', held }),
      emit,
      clear,
      now: () => now,
      intervalMs: 1_000,
    });
    vi.advanceTimersByTime(1_000);
    expect(emit).not.toHaveBeenCalled();
    now = 90_000;
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(1);
    const clearsBeforeHold = clear.mock.calls.length;
    held = true;
    now = 400_000;
    vi.advanceTimersByTime(1_000);
    expect(clear.mock.calls.length).toBe(clearsBeforeHold + 1);
    expect(emit).toHaveBeenCalledTimes(1);
    held = false;
    now = 430_000;
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(1);
    stop();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

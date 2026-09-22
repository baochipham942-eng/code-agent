import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  holdStallClock,
  stallClockHeld,
  startForegroundStallWatch,
  type StallPhase,
} from '../../../src/host/agent/stallObserver';

function quietWatch(detail: string) {
  const emit = vi.fn();
  const clear = vi.fn();
  let now = 0;
  let progressKey = 'boot';
  let phase: StallPhase = 'tool';
  let held = false;
  let currentDetail = detail;
  const stop = startForegroundStallWatch({
    snapshot: () => ({ progressKey, phase, detail: currentDetail, held }),
    emit,
    clear,
    now: () => now,
    intervalMs: 1_000,
  });
  return {
    emit,
    clear,
    stop,
    at(next: number, patch?: { progressKey?: string; phase?: StallPhase; held?: boolean; detail?: string }) {
      now = next;
      if (patch?.progressKey) progressKey = patch.progressKey;
      if (patch?.phase) phase = patch.phase;
      if (patch?.held !== undefined) held = patch.held;
      if (patch?.detail) currentDetail = patch.detail;
      vi.advanceTimersByTime(1_000);
    },
  };
}

describe('StallObserver', () => {
  it('hints at 90s and escalates at 5min while a tool is quiet', () => {
    vi.useFakeTimers();
    const watch = quietWatch('Read');
    watch.at(0);
    watch.at(89_000);
    expect(watch.emit).not.toHaveBeenCalled();
    watch.at(90_000);
    expect(watch.emit).toHaveBeenCalledWith({ level: 'hint', phase: 'tool', detail: 'Read' });
    watch.at(120_000);
    expect(watch.emit).toHaveBeenCalledTimes(1);
    watch.at(300_000);
    expect(watch.emit).toHaveBeenLastCalledWith({ level: 'escalated', phase: 'tool', detail: 'Read' });
    watch.stop();
  });

  it('resets the clock when something visible happens', () => {
    vi.useFakeTimers();
    const watch = quietWatch('Read');
    watch.at(0);
    watch.at(80_000, { progressKey: 'tool:1', phase: 'model', detail: '等模型回响' });
    watch.at(160_000);
    expect(watch.emit).not.toHaveBeenCalled();
    watch.at(170_000);
    expect(watch.emit).toHaveBeenCalledWith({
      level: 'hint', phase: 'model', detail: '等模型回响',
    });
    watch.stop();
  });

  it('a decision wait does not keep the idle clock running', () => {
    vi.useFakeTimers();
    const watch = quietWatch('Bash');
    watch.at(0);
    watch.at(90_000);
    expect(watch.emit).toHaveBeenCalledTimes(1);
    watch.at(4 * 60_000, { held: true });
    expect(watch.emit).toHaveBeenCalledTimes(1);
    watch.at(4 * 60_000 + 89_000, { held: false });
    expect(watch.emit).toHaveBeenCalledTimes(1);
    watch.at(4 * 60_000 + 90_000);
    expect(watch.emit).toHaveBeenLastCalledWith({ level: 'hint', phase: 'tool', detail: 'Bash' });
    watch.stop();
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

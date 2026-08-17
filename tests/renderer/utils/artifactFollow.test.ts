import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactPathFromToolStart,
  createTrailingThrottle,
  decideArtifactFollowOpen,
} from '../../../src/renderer/utils/artifactFollow';

afterEach(() => {
  vi.useRealTimers();
});

describe('artifact follow decisions', () => {
  it('recognizes only phase-one file types from existing write tool starts', () => {
    expect(artifactPathFromToolStart({
      name: 'Write',
      arguments: { file_path: 'reports/monthly.html' },
    }, '/workspace')).toBe('/workspace/reports/monthly.html');
    expect(artifactPathFromToolStart({
      name: 'Write',
      arguments: { file_path: 'reports/data.xlsx' },
    }, '/workspace')).toBeNull();
  });

  it('auto-activates while idle and degrades to attention after workbench interaction', () => {
    expect(decideArtifactFollowOpen({
      paused: false,
      focusInOtherWorkbenchView: false,
      lastWorkbenchInteractionAt: 0,
      now: 10_000,
    })).toEqual({ activate: true, attention: false });

    expect(decideArtifactFollowOpen({
      paused: false,
      focusInOtherWorkbenchView: false,
      lastWorkbenchInteractionAt: 9_000,
      now: 10_000,
    })).toEqual({ activate: false, attention: true });
  });
});

describe('artifact follow disk refresh throttle', () => {
  it('runs immediately, then coalesces repeated file events into one trailing refresh', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const throttle = createTrailingThrottle(refresh, 1_000);

    throttle.trigger();
    throttle.trigger();
    throttle.trigger();
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(999);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

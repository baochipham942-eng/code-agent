import { describe, expect, it, vi } from 'vitest';
import {
  maybeRunQueuedInputStartupSweep,
  type QueuedInputStartupSweepState,
} from '../../../src/web/queuedInputStartupSweep';

describe('queued input startup sweep gate', () => {
  it('ready 先到、trigger 后到时恰好触发一次', () => {
    const trigger = vi.fn();
    const state: QueuedInputStartupSweepState = {
      ready: true,
      trigger: null,
      done: false,
    };

    maybeRunQueuedInputStartupSweep(state);
    state.trigger = trigger;
    maybeRunQueuedInputStartupSweep(state);
    maybeRunQueuedInputStartupSweep(state);

    expect(trigger).toHaveBeenCalledOnce();
    expect(state.done).toBe(true);
  });

  it('trigger 先到、ready 后到时恰好触发一次', () => {
    const trigger = vi.fn();
    const state: QueuedInputStartupSweepState = {
      ready: false,
      trigger,
      done: false,
    };

    maybeRunQueuedInputStartupSweep(state);
    state.ready = true;
    maybeRunQueuedInputStartupSweep(state);
    maybeRunQueuedInputStartupSweep(state);

    expect(trigger).toHaveBeenCalledOnce();
    expect(state.done).toBe(true);
  });
});

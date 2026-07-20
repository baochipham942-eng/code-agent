export interface QueuedInputStartupSweepState {
  ready: boolean;
  trigger: (() => void) | null;
  done: boolean;
}

export function maybeRunQueuedInputStartupSweep(state: QueuedInputStartupSweepState): void {
  if (state.done || !state.ready || !state.trigger) {
    return;
  }
  state.done = true;
  state.trigger();
}

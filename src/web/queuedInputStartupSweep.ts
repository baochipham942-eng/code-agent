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

/**
 * durable rollout ready 和 createApp() 的触发口注册谁先谁后是真竞态（两者独立异步），
 * 这个 gate 把状态收在一处，两个调用点各自调用即可，恰好触发一次。
 */
export function createQueuedInputStartupSweepGate() {
  const state: QueuedInputStartupSweepState = { ready: false, trigger: null, done: false };
  return {
    setReady(ready: boolean): void {
      state.ready = ready;
    },
    registerTrigger(trigger: () => void): void {
      state.trigger = trigger;
    },
    maybeRun(): void {
      maybeRunQueuedInputStartupSweep(state);
    },
  };
}

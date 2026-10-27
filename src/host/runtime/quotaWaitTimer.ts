type QuotaWaitContinuer = (input: { sessionId: string; runId: string }) => Promise<unknown>;

let continuer: QuotaWaitContinuer | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The web process registers this once. Startup recovery never calls it. */
export function registerQuotaWaitContinuer(next: QuotaWaitContinuer | null): void {
  continuer = next;
}

export function clearQuotaWaitTimer(runId: string): void {
  const timer = timers.get(runId);
  if (timer) clearTimeout(timer);
  timers.delete(runId);
}

/**
 * Arm one timer for a live park. No continuer (tests, or a process that has not
 * opened the continue route) means no timer. A due time already reached does not arm.
 */
export function armQuotaWaitOnPark(input: { runId: string; sessionId: string; dueAt: number; now?: number }): void {
  clearQuotaWaitTimer(input.runId);
  if (!continuer) return;
  const delay = input.dueAt - (input.now ?? Date.now());
  if (!(delay > 0)) return;
  const timer = setTimeout(() => {
    timers.delete(input.runId);
    const fn = continuer;
    if (!fn) return;
    void fn({ sessionId: input.sessionId, runId: input.runId }).catch(() => undefined);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(input.runId, timer);
}

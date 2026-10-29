import { createLogger } from '../services/infra/logger';

type QuotaWaitContinuer = (input: { sessionId: string; runId: string }) => Promise<unknown>;

const logger = createLogger('QuotaWaitTimer');

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
    // 失败必须留痕（降级路径留痕错题本）：到点续跑落空时 run 会一直停在 waiting，
    // 不打这条 warn 的话用户与开发者都无从得知自动续跑为何没发生。
    void fn({ sessionId: input.sessionId, runId: input.runId }).catch((error: unknown) => {
      logger.warn('[QuotaWaitTimer] due-time auto-continue failed', {
        runId: input.runId,
        sessionId: input.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(input.runId, timer);
}

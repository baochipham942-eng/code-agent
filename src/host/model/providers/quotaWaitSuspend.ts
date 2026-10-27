/** In-process sleep stays at or below this. A longer quota wait parks the turn. */
const QUOTA_SUSPEND_MIN_EXCLUSIVE_MS = 60_000;

/** Past this, setTimeout cannot be trusted and the capped in-process path stays. */
const QUOTA_SUSPEND_MAX_INCLUSIVE_MS = 24 * 60 * 60 * 1000;

export function isQuotaSuspendWaitMs(waitMs: number): boolean {
  return Number.isFinite(waitMs)
    && waitMs > QUOTA_SUSPEND_MIN_EXCLUSIVE_MS
    && waitMs <= QUOTA_SUSPEND_MAX_INCLUSIVE_MS;
}

/**
 * The turn is parked until `dueAt`. The message is a stable code: it must not
 * look like a retryable provider failure (no status text, no rate-limit wording).
 */
export class QuotaWaitSuspendError extends Error {
  readonly code = 'quota_wait_suspend';
  readonly dueAt: number;
  readonly waitMs: number;

  constructor(dueAt: number, waitMs: number) {
    super('quota_wait_suspend');
    this.name = 'QuotaWaitSuspendError';
    this.dueAt = dueAt;
    this.waitMs = waitMs;
  }
}

export function isQuotaWaitSuspendError(err: unknown): err is QuotaWaitSuspendError {
  if (err instanceof QuotaWaitSuspendError) return true;
  if (!(err instanceof Error) || err.name !== 'QuotaWaitSuspendError') return false;
  const dueAt = (err as { dueAt?: unknown }).dueAt;
  const waitMs = (err as { waitMs?: unknown }).waitMs;
  return typeof dueAt === 'number' && Number.isFinite(dueAt)
    && typeof waitMs === 'number' && Number.isFinite(waitMs);
}

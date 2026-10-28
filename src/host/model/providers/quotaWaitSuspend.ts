import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 挂起资格只活在调用链上：主循环把「本次推理属于一个可停靠 run」包进这个作用域，
 * 转换点（withTransientRetry / aiSdkAdapter 首字节重试）才允许把长等待换成挂起。
 * 作用域外的一切调用（后台标题生成、辅助子 run、非持久会话）保持原封顶重试 + 降级链。
 */
const suspendEligibilityScope = new AsyncLocalStorage<boolean>();

export function runWithQuotaWaitSuspendEligibility<T>(eligible: boolean, run: () => Promise<T>): Promise<T> {
  return suspendEligibilityScope.run(eligible, run);
}

export function isQuotaWaitSuspendEligible(): boolean {
  return suspendEligibilityScope.getStore() === true;
}

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

import { isQuotaWaitSuspendError } from '../../../model/providers/quotaWaitSuspend';

const dueAtByRun = new Map<string, number>();

export function peekQuotaWaitDueAt(runId: string): number | undefined {
  return dueAtByRun.get(runId);
}

export function clearQuotaWaitNote(runId: string): void {
  dueAtByRun.delete(runId);
}

/** Remember the due time and end the turn the same way a user cancel does. */
export function settleQuotaWaitInference(
  error: unknown,
  input: { runId?: string; markCancelled: () => void },
): boolean {
  if (!isQuotaWaitSuspendError(error)) return false;
  if (input.runId && Number.isFinite(error.dueAt)) dueAtByRun.set(input.runId, error.dueAt);
  input.markCancelled();
  return true;
}

import { isQuotaWaitSuspendError } from '../../../model/providers/quotaWaitSuspend';
import { getConfiguredApplicationRunRegistry } from '../../../app/applicationRunRegistry';
import { isQuotaWaitParkableRun } from '../../../runtime/quotaWaitParkability';

const dueAtByRun = new Map<string, number>();

export function peekQuotaWaitDueAt(runId: string): number | undefined {
  return dueAtByRun.get(runId);
}

export function clearQuotaWaitNote(runId: string): void {
  dueAtByRun.delete(runId);
}

/**
 * Remember the due time and end the turn the same way a user cancel does.
 * 只收可停靠 run 的挂起：非可停靠（辅助子 run / 无 descriptor / 非持久会话）返回 false，
 * 让错误落回通用失败路径（可见、可降级）——绝不静默取消（rework r1 Important）。
 */
export function settleQuotaWaitInference(
  error: unknown,
  input: { runId?: string; markCancelled: () => void },
): boolean {
  if (!isQuotaWaitSuspendError(error)) return false;
  if (!isQuotaWaitParkableRun(getConfiguredApplicationRunRegistry(), input.runId)) return false;
  if (input.runId && Number.isFinite(error.dueAt)) dueAtByRun.set(input.runId, error.dueAt);
  input.markCancelled();
  return true;
}

import type { PendingOperation, RunEnvelope } from '../../shared/contract/durableRun';

/**
 * Recovered waiting native runs have an owner lease but no control handle.
 * They block a new root run on the same session until cancelled.
 */
export function findRecoveredWaitingRun(
  envelopes: Iterable<RunEnvelope>,
  hasHandle: (runId: string) => boolean,
  hasOwner: (runId: string) => boolean,
  selector: { runId?: string; sessionId?: string },
): { runId: string; sessionId: string } | undefined {
  const runId = selector.runId?.trim();
  const sessionId = selector.sessionId?.trim();
  if (!runId && !sessionId) return undefined;
  for (const envelope of envelopes) {
    if (envelope.status !== 'waiting') continue;
    if (runId && envelope.runId !== runId) continue;
    if (sessionId && envelope.sessionId !== sessionId) continue;
    if (!runId && envelope.parentRunId) continue;
    if (hasHandle(envelope.runId) || !hasOwner(envelope.runId)) continue;
    return { runId: envelope.runId, sessionId: envelope.sessionId };
  }
  return undefined;
}

/**
 * 手动「继续」由新的 live loop 接管这一轮：停靠时残留的在途模型调用（预算耗尽停靠不做 fence）
 * 必须同笔收口，否则这轮结束时 completed 被「存在未决 op」拒写、run 永远落不了终态。
 * 工具类 op 不动（未知写不重放，K2 语义）。
 */
export function settleModelOpsForManualContinue(operations: PendingOperation[], now: number): PendingOperation[] {
  return operations.map((operation) => (
    operation.kind === 'model_call' && ['prepared', 'dispatched', 'unknown'].includes(operation.status)
      ? { ...operation, status: 'abandoned' as const, resultRef: `model-recovery:superseded-by-manual-continue:${operation.operationId}`, updatedAt: now }
      : operation
  ));
}

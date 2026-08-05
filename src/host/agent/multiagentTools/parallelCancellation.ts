// ============================================================================
// parallelCancellation - 并行编排取消判定助手
// ============================================================================
// 从 spawnAgent.ts 的 executeParallelAgents 闭包中原样搬出（max-lines 门），
// 语义零变化：abortSignal 改为显式入参。
// ============================================================================

import { normalizeCancellationReason, routeFailureCode } from '../../../shared/contract/cancellation';
import {
  AgentFailureCode,
  agentFailureCodeFromCancellationReason,
} from '../../../shared/contract/agentFailure';
import type { MultiagentExecutionResult } from '../multiagentExecutionTypes';

export function isCancelledTaskError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('cancel') || normalized.includes('abort') || errorMessage.includes('取消');
}

export function getParallelCancellationResult(abortSignal?: AbortSignal): MultiagentExecutionResult | null {
  if (!abortSignal?.aborted) return null;
  const cancellationReason = normalizeCancellationReason(
    abortSignal.reason,
    'parent-cancel',
  );
  return {
    success: false,
    error: `Parallel launch cancelled (${String(abortSignal.reason ?? 'parent-cancel')})`,
    metadata: {
      cancellationReason,
      failureRouting: routeFailureCode(cancellationReason),
      failureCode: agentFailureCodeFromCancellationReason(cancellationReason)
        ?? AgentFailureCode.CancelledByParent,
    },
  };
}

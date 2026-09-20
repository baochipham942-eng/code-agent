// ContextAssembly - Diagnostic signals for automatic compression paths.
import type { AgentEvent, ContextCompressionSignalData } from '../../../../shared/contract';
import { CONTEXT_LEDGER } from '../../../../shared/constants';
import { getContextEventLedger } from '../../../context/contextEventLedger';
import type { ContextAssemblyCtx } from './shared';

export function emitContextCompressionSignal(
  ctx: ContextAssemblyCtx,
  signal: Omit<ContextCompressionSignalData, 'signalId' | 'timestamp'>,
): void {
  const data: ContextCompressionSignalData = {
    ...signal,
    signalId: ctx.generateId(),
    timestamp: Date.now(),
  };
  ctx.runtime.onEvent({ type: 'context_compression_signal', data } as AgentEvent);
  getContextEventLedger().upsertEvents([{
    id: '',
    sessionId: ctx.runtime.sessionId,
    agentId: ctx.runtime.agentId,
    invocationId: data.signalId,
    category: 'unknown',
    action: 'added',
    sourceKind: CONTEXT_LEDGER.SOURCE_KIND.COMPRESSION_SIGNAL,
    sourceDetail: `compression-signal:${data.code}`,
    layer: 'diagnostic',
    reason: data.code,
    timestamp: data.timestamp,
  }]);
}

export function emitOverflowRecoverySignal(ctx: ContextAssemblyCtx, tokensBefore: number): void {
  emitContextCompressionSignal(ctx, {
    kind: 'overflow-recovery',
    code: 'overflow-recovery-started',
    surface: 'conversation',
    retryable: true,
    tokensBefore,
    messagesCount: ctx.runtime.messages.length,
  });
}

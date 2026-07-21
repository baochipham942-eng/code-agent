import type { RunRegistry } from '../../runtime/runRegistry';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';

export interface SurfaceRunOwnerIdentity {
  conversationId: string;
  runId: string;
  agentId: string;
}

export function assertSurfaceRunOwner(input: {
  runRegistry: RunRegistry;
  identity: SurfaceRunOwnerIdentity;
  surface: 'browser' | 'computer';
  provider: string;
  access: 'active' | 'cleanup';
}): void {
  const { identity } = input;
  if (!identity.conversationId.trim() || !identity.runId.trim() || !identity.agentId.trim()) {
    throw new Error('Surface execution requires conversationId, runId, and agentId.');
  }
  const handle = input.runRegistry.resolve({
    runId: identity.runId,
    sessionId: identity.conversationId,
  });
  const durableTrace = input.runRegistry.getTraceContext(identity.runId);
  const durableOwnerMissing = Boolean(durableTrace)
    && !input.runRegistry.hasDurableOwner(identity.runId);
  if (
    !handle
    || (input.access === 'active' && handle.cancellationRequested)
    || durableOwnerMissing
  ) {
    throw new SurfaceExecutionRuntimeError({
      code: 'SURFACE_TARGET_NOT_OWNED',
      message: 'Surface execution owner is not the active RunRegistry handle.',
      phase: 'prepare',
      recommendedAction: 'Use the active run and conversation owner.',
      surface: input.surface,
      provider: input.provider,
      sessionId: 'unbound',
      detailsSafe: {
        conversationId: identity.conversationId,
        runId: identity.runId,
        agentId: identity.agentId,
      },
    });
  }
}

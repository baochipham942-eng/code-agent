import type { RunEnvelope } from '../../shared/contract/durableRun';

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

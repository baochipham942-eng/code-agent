import { createLogger } from '../infra/logger';
import type { TraceEventDataMap, TurnTraceRecorder } from '../../agent/runtime/turnTrace';

const logger = createLogger('CapabilityLifecycleTrace');

/** Append-only, fail-safe side ledger: trace failures never alter capability state. */
export function recordCapabilityLifecycle(
  turnTrace: TurnTraceRecorder,
  data: TraceEventDataMap['capability_lifecycle'],
): void {
  try {
    turnTrace.record('capability_lifecycle', data);
    if (!turnTrace.flush()) logger.warn('capability lifecycle trace flush failed', { capabilityKey: data.capabilityKey });
  } catch (error) {
    logger.warn('capability lifecycle trace failed', {
      capabilityKey: data.capabilityKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

import { clearSessionCachePrompt } from '../agent/runtime/turnCostPersistence';
import { clearSessionCacheHits } from '../model/cacheHitObservation';

/** Release process-local observations when a host session ends. */
export function clearSessionRuntimeCaches(sessionId: string): void {
  clearSessionCachePrompt(sessionId);
  clearSessionCacheHits(sessionId);
}

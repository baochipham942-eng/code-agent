import { clearSessionCachePrompt } from '../agent/runtime/turnCostPersistence';
import { clearSessionCacheHits } from '../model/cacheHitObservation';
import { getToolSearchService } from '../services/toolSearch/toolSearchService';

/** Release process-local observations when a host session ends. */
export function clearSessionRuntimeCaches(sessionId: string): void {
  clearSessionCachePrompt(sessionId);
  clearSessionCacheHits(sessionId);
  getToolSearchService().releaseSession(sessionId);
}

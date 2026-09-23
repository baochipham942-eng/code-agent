/** Release process-local observations when a host session ends. */
export async function clearSessionRuntimeCaches(sessionId: string): Promise<void> {
  await Promise.all([
    import('../agent/runtime/turnCostPersistence').then(({ clearSessionCachePrompt }) => {
      clearSessionCachePrompt(sessionId);
    }),
    import('../model/cacheHitObservation').then(({ clearSessionCacheHits }) => {
      clearSessionCacheHits(sessionId);
    }),
  ]);
}

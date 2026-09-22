import type { InferenceCache } from './inferenceCache';
import type { InferenceOptions, ModelResponse } from './types';
import type { ModelConfig } from '../../shared/contract';

interface CacheLogger {
  info(message: string, ...args: unknown[]): void;
}

export function observeInferenceCache(
  options: InferenceOptions | undefined,
  cached: ModelResponse | null | undefined,
  cache: InferenceCache,
  config: ModelConfig,
  logger: CacheLogger,
): ModelResponse | undefined {
  if (options?.cacheScopeId) {
    logger.info('[Cache] cacheScopeId recorded without changing the cache bucket', {
      cacheScopeId: options.cacheScopeId,
      cacheRetention: options.cacheRetention ?? 'default',
    });
  }
  if (!cached) return undefined;
  const inferenceHitRate = cache.getStats().hitRate;
  logger.info(`[Cache] Hit for ${config.provider}/${config.model} hitRate=${inferenceHitRate}`);
  cached.runtimeDiagnostics = { ...cached.runtimeDiagnostics, inferenceCacheHit: true };
  return cached;
}

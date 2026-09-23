import type { ModelResponse } from '../../agent/loopTypes';
import type { TurnTraceRecorder } from './turnTrace';

export function recordInferenceTrace(
  trace: TurnTraceRecorder,
  response: ModelResponse,
  durationMs: number,
  cacheHit?: { providerCacheHitAdvancing: number; providerCacheHitStagnant: number },
): void {
  trace.record('inference', {
    responseType: response.type,
    durationMs,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
    ...(response.usage?.cacheReadTokens !== undefined ? { cacheReadTokens: response.usage.cacheReadTokens } : {}),
    ...(cacheHit ? { ...cacheHit } : {}),
    finishReason: response.finishReason ?? null,
    truncated: response.truncated ?? false,
  });
}

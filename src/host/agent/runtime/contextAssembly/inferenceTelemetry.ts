import type { ModelResponse } from '../../../agent/loopTypes';
import { getTelemetryService } from '../../../telemetry/telemetryService';
import type { ContextAssemblyCtx } from './shared';

export async function runInferenceWithTelemetry(
  ctx: ContextAssemblyCtx,
  run: () => Promise<ModelResponse>,
): Promise<ModelResponse> {
  const startedAt = Date.now();
  let modelSpanId: string | undefined;
  ctx.runtime.lastModelTraceSpanId = undefined;
  try {
    const turnSpan = getTelemetryService().findActiveSpanByAttribute('agent.id', ctx.runtime.turn.currentTurnId);
    const modelSpan = getTelemetryService().startModelSpan(
      ctx.runtime.modelConfig.model,
      ctx.runtime.modelConfig.provider,
      turnSpan?.spanId,
    );
    modelSpanId = modelSpan.spanId;
    ctx.runtime.lastModelTraceSpanId = modelSpanId;
    getTelemetryService().updateSpan(modelSpanId, {
      'model.request_protocol': 'agent-loop',
      'model.retry_count': ctx.runtime._networkRetryCount ?? 0,
    });
  } catch {
    // Model execution is independent from tracing availability.
  }

  try {
    const response = await run();
    if (modelSpanId) {
      try {
        getTelemetryService().endSpan(modelSpanId, 'ok', {
          'model.provider': response.actualProvider ?? response.fallback?.to.provider ?? ctx.runtime.modelConfig.provider,
          'model.name': response.actualModel ?? response.fallback?.to.model ?? ctx.runtime.modelConfig.model,
          'model.input_tokens': response.usage?.inputTokens ?? 0,
          'model.output_tokens': response.usage?.outputTokens ?? 0,
          'model.latency_ms': Date.now() - startedAt,
          'model.result_status': 'success',
        });
      } catch {
        // Model execution is independent from tracing availability.
      }
    }
    return response;
  } catch (error) {
    if (modelSpanId) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = ctx.runtime.control.isCancelled || ctx.runtime.control.isInterrupted || /cancel|abort/i.test(message);
      const timedOut = /timeout|timed out|超时/i.test(message);
      try {
        getTelemetryService().endSpan(modelSpanId, cancelled ? 'cancelled' : 'error', {
          'model.latency_ms': Date.now() - startedAt,
          'model.result_status': timedOut ? 'timeout' : cancelled ? 'cancelled' : 'error',
        });
      } catch {
        // Model execution is independent from tracing availability.
      }
    }
    throw error;
  }
}

import { logCollector } from '../../../mcp/logCollector.js';
import type { LangfuseService } from '../../../services/infra/langfuseService';
import { parseImagePayloadError } from '../../../model/providers/shared';
import type { ContextAssemblyCtx } from './shared';
import { logger } from './shared';

function readHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = (error as { status?: unknown; statusCode?: unknown }).status
    ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof candidate === 'number') return candidate;
  return typeof candidate === 'string' && /^\d+$/.test(candidate)
    ? Number(candidate)
    : undefined;
}

function readStringField(error: unknown, field: 'provider' | 'model'): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = (error as Record<string, unknown>)[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * 把供应商 413 / request_too_large / 图片数量超限归一成稳定错误事件。
 * 技术 message 保持英文；renderer 只按 code 选择 zh/en 用户文案。
 */
export function handleImagePayloadExceededError(args: {
  ctx: ContextAssemblyCtx;
  error: unknown;
  llmCallId: string;
  langfuse: LangfuseService;
}): boolean {
  const { ctx, error, llmCallId, langfuse } = args;
  const provider = readStringField(error, 'provider') ?? ctx.runtime.modelConfig.provider;
  const imagePayloadError = parseImagePayloadError(
    error instanceof Error ? error.message : String(error),
    provider,
    readHttpStatus(error),
  );
  if (!imagePayloadError) return false;

  logger.warn('[AgentLoop] Image payload exceeded provider limits', {
    provider: imagePayloadError.provider,
    reason: imagePayloadError.reason,
    httpStatus: imagePayloadError.httpStatus,
  });
  logCollector.agent('WARN', `Image payload exceeded provider limits: ${imagePayloadError.reason}`);
  langfuse.endGeneration(
    llmCallId,
    { error: imagePayloadError.message },
    undefined,
    'ERROR',
    imagePayloadError.message,
  );
  ctx.runtime.onEvent({
    type: 'error',
    data: {
      code: imagePayloadError.code,
      message: imagePayloadError.message,
      details: {
        provider: imagePayloadError.provider,
        model: readStringField(error, 'model') ?? ctx.runtime.modelConfig.model,
        reason: imagePayloadError.reason,
        httpStatus: imagePayloadError.httpStatus,
      },
    },
  });
  return true;
}

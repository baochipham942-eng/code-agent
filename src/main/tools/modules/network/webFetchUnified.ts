// ============================================================================
// WebFetch Unified (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/web/WebFetchUnifiedTool.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy WebFetchUnifiedTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为直调 webFetch + httpRequest，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { WebFetchUnifiedTool } from '../../web/WebFetchUnifiedTool';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { webFetchUnifiedSchema as schema } from './webFetchUnified.schema';
import { detectAntiScrapingHint } from './antiScrapingDetector';

class WebFetchUnifiedHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const validationError = validateWebFetchUnifiedArgs(args);
    if (validationError) return validationError;

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const action = typeof args.action === 'string' ? args.action : undefined;
    onProgress?.({ stage: 'starting', detail: action ? `WebFetch ${action}` : 'WebFetch' });

    const legacyResult = await WebFetchUnifiedTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('WebFetch done', { action, ok: legacyResult.success });

    // 反爬检测：在 result 末尾追加 hint，提示模型走 Bash + 本地 CLI 替代方案。
    // 不修改 success/failure 判定，只增量信息——让模型自己决定是否换路径。
    const url = typeof args.url === 'string' ? args.url : undefined;
    const hint = detectAntiScrapingHint(url, legacyResult.success, legacyResult.output, legacyResult.error);
    if (hint) {
      if (legacyResult.success && typeof legacyResult.output === 'string') {
        legacyResult.output = `${legacyResult.output}\n\n${hint}`;
      } else if (!legacyResult.success && typeof legacyResult.error === 'string') {
        legacyResult.error = `${legacyResult.error}\n\n${hint}`;
      }
      ctx.logger.debug('WebFetch anti-scraping hint emitted', { url });
    }

    return adaptLegacyResult(legacyResult);
  }
}

function validateWebFetchUnifiedArgs(args: Record<string, unknown>): ToolResult<string> | null {
  const action = args.action;
  if (action !== 'fetch' && action !== 'request') {
    return { ok: false, error: 'Invalid WebFetch action. Use "fetch" or "request".', code: 'INVALID_ARGS' };
  }

  if (typeof args.url !== 'string' || args.url.trim().length === 0) {
    return { ok: false, error: 'WebFetch requires a non-empty url.', code: 'INVALID_ARGS' };
  }

  if (action === 'fetch' && (typeof args.prompt !== 'string' || args.prompt.trim().length === 0)) {
    return { ok: false, error: 'WebFetch action "fetch" requires a non-empty prompt.', code: 'INVALID_ARGS' };
  }

  return null;
}

export const webFetchUnifiedModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WebFetchUnifiedHandler();
  },
};

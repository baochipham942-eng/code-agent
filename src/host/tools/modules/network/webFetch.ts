// ============================================================================
// web_fetch (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/web/webFetch.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy webFetchTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为直调 fetchDocument/extractOrTruncate，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { webFetchTool } from '../../web/webFetch';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { webFetchSchema as schema } from './webFetch.schema';

function safeUrlName(url: string | undefined, fallback: string): string {
  if (!url) return fallback;
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

class WebFetchHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const url = typeof args.url === 'string' ? args.url : undefined;
    onProgress?.({ stage: 'starting', detail: url ? `web_fetch ${url}` : 'web_fetch' });

    const legacyResult = await webFetchTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('web_fetch done', { url, ok: legacyResult.success });
    const result = adaptLegacyResult(legacyResult);
    if (result.ok) {
      return {
        ...result,
        meta: {
          ...(result.meta ?? {}),
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'web',
            sessionId: ctx.sessionId,
            name: safeUrlName(url, 'web_fetch result'),
            url,
            mimeType: 'text/markdown',
            contentLength: result.output.length,
            preview: result.output.slice(0, 500),
            metadata: {
              prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
            },
          }),
        },
      };
    }
    return result;
  }
}

export const webFetchModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WebFetchHandler();
  },
};

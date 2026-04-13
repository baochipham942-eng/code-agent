// ============================================================================
// Diagnostics (P0-5 Migrated, wrapper mode)
//
// 旧版: src/main/tools/lsp/diagnostics.ts (registered as 'diagnostics')
// wrapper 委托给 legacy 实现（依赖 LSP manager singleton）
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { diagnosticsTool } from '../../lsp/diagnostics';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { diagnosticsSchema as schema } from './diagnostics.schema';

class DiagnosticsHandler implements ToolHandler<Record<string, unknown>, string> {
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

    onProgress?.({ stage: 'starting', detail: 'lsp diagnostics' });
    const legacyResult = await diagnosticsTool.execute(args, buildLegacyCtxFromProtocol(ctx));
    onProgress?.({ stage: 'completing', percent: 100 });
    return adaptLegacyResult(legacyResult);
  }
}

export const diagnosticsModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new DiagnosticsHandler();
  },
};

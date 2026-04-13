// ============================================================================
// LSP (P0-5 Migrated, wrapper mode)
//
// 旧版: src/main/tools/lsp/lsp.ts (registered as 'lsp', 740 行)
// wrapper 委托给 legacy 实现。LSP 工具体量大且 helper functions 都是内部
// (formatLocationResult/formatHoverResult/...)，全量迁会复制 600 行 helper。
// 改用 wrapper 让批量进度优先，最后阶段再决定要不要原生化。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { lspTool } from '../../lsp/lsp';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { lspSchema as schema } from './lsp.schema';

class LspHandler implements ToolHandler<Record<string, unknown>, string> {
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

    const operation = args.operation as string | undefined;
    onProgress?.({ stage: 'starting', detail: `lsp ${operation ?? 'op'}` });

    const legacyResult = await lspTool.execute(args, buildLegacyCtxFromProtocol(ctx));
    onProgress?.({ stage: 'completing', percent: 100 });
    return adaptLegacyResult(legacyResult);
  }
}

export const lspModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new LspHandler();
  },
};

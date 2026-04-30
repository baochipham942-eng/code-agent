// ============================================================================
// MCP Invoke (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/mcp/mcpTool.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy mcpTool。
// 后续 Level 2 rewrite 时，把 legacy 调用替换为 mcpClient 直调即可，schema 保持。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { mcpTool } from '../../mcp/mcpTool';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { mcpInvokeSchema as schema } from './mcpInvoke.schema';

class McpInvokeHandler implements ToolHandler<Record<string, unknown>, string> {
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

    const server = typeof args.server === 'string' ? args.server : undefined;
    const tool = typeof args.tool === 'string' ? args.tool : undefined;
    onProgress?.({ stage: 'starting', detail: server && tool ? `mcp ${server}.${tool}` : 'mcp' });

    const legacyResult = await mcpTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('mcp done', { server, tool, ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const mcpInvokeModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new McpInvokeHandler();
  },
};

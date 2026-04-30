// ============================================================================
// MCP Unified (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/mcp/MCPUnifiedTool.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy MCPUnifiedTool。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { MCPUnifiedTool } from '../../mcp/MCPUnifiedTool';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { mcpUnifiedSchema as schema } from './mcpUnified.schema';

class McpUnifiedHandler implements ToolHandler<Record<string, unknown>, string> {
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

    const action = typeof args.action === 'string' ? args.action : undefined;
    onProgress?.({ stage: 'starting', detail: action ? `MCPUnified ${action}` : 'MCPUnified' });

    const legacyResult = await MCPUnifiedTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('MCPUnified done', { action, ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const mcpUnifiedModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new McpUnifiedHandler();
  },
};

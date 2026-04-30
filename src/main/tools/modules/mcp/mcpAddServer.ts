// ============================================================================
// MCP Add Server (Level 1 native module — wrapper-mode)
//
// 旧版: src/main/tools/mcp/mcpAddServer.ts (legacy Tool)
// 当前版本：手写 wrapper boilerplate，仍 delegate 给 legacy mcpAddServerTool。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { mcpAddServerTool } from '../../mcp/mcpAddServer';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { mcpAddServerSchema as schema } from './mcpAddServer.schema';

class McpAddServerHandler implements ToolHandler<Record<string, unknown>, string> {
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

    const name = typeof args.name === 'string' ? args.name : undefined;
    const type = typeof args.type === 'string' ? args.type : undefined;
    onProgress?.({ stage: 'starting', detail: name && type ? `mcp_add_server ${name} (${type})` : 'mcp_add_server' });

    const legacyResult = await mcpAddServerTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('mcp_add_server done', { name, type, ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const mcpAddServerModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new McpAddServerHandler();
  },
};

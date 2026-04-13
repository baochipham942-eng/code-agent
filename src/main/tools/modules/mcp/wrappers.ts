// ============================================================================
// mcp/ batch — 3 工具的 wrapper 模式实现
// ============================================================================

import { mcpTool } from '../../mcp/mcpTool';
import { MCPUnifiedTool } from '../../mcp/MCPUnifiedTool';
import { mcpAddServerTool } from '../../mcp/mcpAddServer';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

const MCP_NETWORK = { category: 'mcp' as const, permissionLevel: 'network' as const };

export const mcpModule = wrapLegacyTool(mcpTool, MCP_NETWORK);
export const mcpUnifiedModule = wrapLegacyTool(MCPUnifiedTool, MCP_NETWORK);
export const mcpAddServerModule = wrapLegacyTool(mcpAddServerTool, {
  category: 'mcp',
  permissionLevel: 'write',
});

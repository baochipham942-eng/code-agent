// ============================================================================
// connectorScopeCard —— MCP 工具因权限范围不足失败时，给聊天发一张「重新授权」连接卡
// ============================================================================
// 工具失败的 ToolResult.metadata 带 mcpInsufficientScope（mcpClient 写入）；引擎在 tool_call_end
// 之后调这里，把它转成 connector_required(reason:'insufficient_scope')。每次失败的工具调用至多一张，
// 事件走 ctx.onEvent，agentAppService 与 web routes/agent 两条发射路径共用。
// helpUrl 只来自「已核实官方权限页」表，表里没有就不带。
// ============================================================================

import type { AgentEvent, ToolResult } from '../../../shared/contract';
import { getMcpPermissionPageUrl, MCP_PERMISSION_PAGE_URLS } from '../../../shared/constants';
import { MCP_INSUFFICIENT_SCOPE_METADATA_KEY } from '../../mcp/mcpErrors';

export function buildInsufficientScopeConnectorEvent(
  result: ToolResult,
  permissionPages: Readonly<Record<string, string>> = MCP_PERMISSION_PAGE_URLS,
): AgentEvent | null {
  if (result.success) return null;
  const metadata = result.metadata as Record<string, unknown> | undefined;
  const info = metadata?.[MCP_INSUFFICIENT_SCOPE_METADATA_KEY];
  if (!info || typeof info !== 'object') return null;
  const server = metadata?.serverName ?? metadata?.server;
  if (typeof server !== 'string' || !server) return null;
  const { requiredScope } = info as { requiredScope?: unknown };
  const helpUrl = getMcpPermissionPageUrl(server, permissionPages);
  return {
    type: 'connector_required',
    data: {
      connectors: [{
        id: server,
        source: 'selected',
        reason: 'insufficient_scope',
        ...(typeof requiredScope === 'string' && requiredScope ? { requiredScope } : {}),
        ...(helpUrl ? { helpUrl } : {}),
      }],
    },
  };
}

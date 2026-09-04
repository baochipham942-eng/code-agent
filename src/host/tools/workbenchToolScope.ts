import type { ToolDefinition } from '../../shared/contract';
import type { WorkbenchToolScope } from '../../shared/contract/conversationEnvelope';
import {
  CONNECTOR_TOOL_NAMES,
  MCP_META_TOOL_NAMES,
  extractMcpServerIdFromToolName,
  isConnectorToolName,
} from '../../shared/contract/workbenchTools';

function normalizeIds(ids?: string[]): string[] {
  return Array.from(new Set((ids || []).map((id) => id.trim()).filter(Boolean)));
}

export function normalizeWorkbenchToolScope(
  scope?: WorkbenchToolScope,
): WorkbenchToolScope | undefined {
  if (!scope) {
    return undefined;
  }

  const allowedSkillIds = normalizeIds(scope.allowedSkillIds);
  const allowedConnectorIds = normalizeIds(scope.allowedConnectorIds);
  const allowedMcpServerIds = normalizeIds(scope.allowedMcpServerIds);

  if (allowedSkillIds.length === 0 && allowedConnectorIds.length === 0 && allowedMcpServerIds.length === 0) {
    return undefined;
  }

  return {
    ...(allowedSkillIds.length > 0 ? { allowedSkillIds } : {}),
    ...(allowedConnectorIds.length > 0 ? { allowedConnectorIds } : {}),
    ...(allowedMcpServerIds.length > 0 ? { allowedMcpServerIds } : {}),
  };
}

function matchesScopedMcpTool(toolName: string, allowedServerIds: string[]): boolean {
  const serverId = extractMcpServerIdFromToolName(toolName);
  if (!serverId) {
    return true;
  }

  return allowedServerIds.includes(serverId);
}

function matchesScopedConnectorTool(toolName: string, allowedConnectorIds: string[]): boolean {
  if (!isConnectorToolName(toolName)) {
    return true;
  }

  const allowedToolNames = new Set(
    allowedConnectorIds.flatMap((connectorId) => CONNECTOR_TOOL_NAMES[connectorId] || []),
  );
  return allowedToolNames.has(toolName);
}

export function isToolNameAllowedByWorkbenchScope(
  toolName: string,
  scope?: WorkbenchToolScope,
): boolean {
  const normalizedScope = normalizeWorkbenchToolScope(scope);
  if (!normalizedScope) {
    return true;
  }

  if (normalizedScope.allowedMcpServerIds?.length
    && !matchesScopedMcpTool(toolName, normalizedScope.allowedMcpServerIds)) {
    return false;
  }

  if (normalizedScope.allowedConnectorIds?.length
    && !matchesScopedConnectorTool(toolName, normalizedScope.allowedConnectorIds)) {
    return false;
  }

  return true;
}

// MCPUnified 的 action 里只有这两个会去碰某台 server 的数据；
// list_tools / list_resources / status / add_server 不按 server 挡
//（list 类的输出在 mcpUnified 模块里按同一份 scope 过滤）。
const MCP_SERVER_DATA_ACTIONS: ReadonlySet<string> = new Set(['invoke', 'read_resource']);

/**
 * dispatch 侧的门：比 isToolNameAllowedByWorkbenchScope 多管一件事——
 * `mcp` / `MCPUnified` 这类元工具把 server 放在**参数**里，按工具名判不到
 * （extractMcpServerIdFromToolName 对它们返回 undefined ⇒ 名字那道一律放行）。
 * 收窄生效时要碰 server 数据就必须报得出在名单内的 server，报不出 ⇒ fail-closed。
 */
export function isToolCallAllowedByWorkbenchScope(
  toolName: string,
  args: unknown,
  scope?: WorkbenchToolScope,
): boolean {
  if (!isToolNameAllowedByWorkbenchScope(toolName, scope)) {
    return false;
  }

  const allowedServerIds = normalizeWorkbenchToolScope(scope)?.allowedMcpServerIds;
  if (!allowedServerIds?.length || !MCP_META_TOOL_NAMES.has(toolName)) {
    return true;
  }

  const record = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (toolName === 'MCPUnified' && !MCP_SERVER_DATA_ACTIONS.has(String(record.action))) {
    return true;
  }
  if (toolName === 'mcp_add_server') {
    return true;
  }

  return typeof record.server === 'string' && allowedServerIds.includes(record.server);
}

export function isSkillCommandAllowedByWorkbenchScope(
  skillName: string,
  scope?: WorkbenchToolScope,
): boolean {
  const normalizedScope = normalizeWorkbenchToolScope(scope);
  if (!normalizedScope?.allowedSkillIds?.length) {
    return true;
  }

  return normalizedScope.allowedSkillIds.includes(skillName);
}

export function filterToolDefinitionsByWorkbenchScope(
  tools: ToolDefinition[],
  scope?: WorkbenchToolScope,
): ToolDefinition[] {
  const normalizedScope = normalizeWorkbenchToolScope(scope);
  if (!normalizedScope) {
    return tools;
  }

  return tools.filter((tool) => isToolNameAllowedByWorkbenchScope(tool.name, normalizedScope));
}
